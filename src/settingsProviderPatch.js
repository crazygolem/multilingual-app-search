// Patches the Settings search provider so that it also returns the panels that
// match in the untranslated strings (usually English).
//
// The Shell gets the Settings panels from a D-Bus search provider that runs in
// the gnome-control-center process, and that provider only matches the panels'
// strings in the session's language.
//
// That provider can't be extended, so instead this patches the Shell's side of
// it: its results are kept as they are, and the panels matched in the shadow
// copies of the desktop files (see shadowSearch.js) are appended to them.
//
// The provider then supplies the names and icons of the extra results
// (GetResultMetas) and opens them (ActivateResult).
//
// The extra panels are matched with GLib's rules rather than the Settings
// provider's, which leads to a limitation: GLib only matches the names and
// keywords, while the Settings provider also matches the descriptions (the
// Comment key of the desktop files).
// cf. https://gitlab.gnome.org/GNOME/gnome-control-center/-/blob/51.1/shell/cc-shell-model.c#L292-316

import Gio from 'gi://Gio'
import GioUnix from 'gi://GioUnix'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js'

import {settingsPanelId} from './shadowSearch.js'

const PROVIDER_ID = 'org.gnome.Settings.desktop'
const SEARCH_PROVIDERS_SCHEMA = 'org.gnome.desktop.search-providers'

// The remote provider classes aren't exported, so their prototype is taken from
// the providers the overview has loaded (it does so before extensions get
// enabled). Patching the prototype rather than the instances keeps working
// when the overview reloads its providers, e.g. whenever an app gets installed,
// because it then creates new instances of the same classes.
//
// cf. https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/51.1/js/ui/search.js#L671-679
function findRemoteProviderPrototype() {
    const providers = Main.overview.searchController?._searchResults?._providers ?? []

    for (const provider of providers.filter(p => p.isRemoteProvider)) {
        for (let proto = Object.getPrototypeOf(provider);
            proto && proto !== Object.prototype;
            proto = Object.getPrototypeOf(proto)) {
            if (Object.hasOwn(proto, 'getInitialResultSet') && Object.hasOwn(proto, 'getSubsearchResultSet'))
                return proto
        }
    }

    return null
}

// Whether the Shell loads Settings' search provider, according to the Search
// settings and Settings' app. Settings' provider isn't DefaultDisabled, so only
// the `disabled` list applies to it. Parental controls, which can also hide the
// app, aren't accounted for.
//
// cf. https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/51.1/js/ui/remoteSearch.js#L97-159
function isProviderEnabled() {
    const settings = new Gio.Settings({schema_id: SEARCH_PROVIDERS_SCHEMA})
    return !settings.get_boolean('disable-external') &&
        !settings.get_strv('disabled').includes(PROVIDER_ID) &&
        GioUnix.DesktopAppInfo.new(PROVIDER_ID)?.should_show() === true
}

/**
 * Patches Settings' search provider so that the panels that match in both
 * languages get appended to its results, until destroyed.
 */
export class SettingsProviderPatch {
    #shadowSearch
    #injections = new InjectionManager()
    // Kept, as Gio.AppInfoMonitor.get() returns a new monitor once the
    // previous one is finalized, which would drop the handler
    #monitor
    #monitorHandlerId
    // Whether the provider knows the panel with a given ID, for the panels
    // that were checked
    #known = new Map()

    /**
     * @param {import('./shadowSearch.js').ShadowSearch} shadowSearch
     * @param {string} logPrefix for the messages logged about it
     */
    constructor(shadowSearch, logPrefix) {
        this.#shadowSearch = shadowSearch
        this.#monitor = Gio.AppInfoMonitor.get()
        this.#monitorHandlerId = this.#monitor.connect('changed', () => this.#known.clear())

        // Either no remote provider is loaded, e.g. when the user disabled them
        // all in the Search settings (reenabling them won't be noticed until
        // the extension gets enabled again), or the Shell's internals changed.
        // Only the latter is possible when Settings' provider is loaded.
        const proto = findRemoteProviderPrototype()
        if (!proto) {
            if (isProviderEnabled()) {
                console.warn("[%s]", logPrefix,
                    "could not find the Shell's remote search providers, so",
                    "the Settings panels will only get the stock results;",
                    "it is likely due to a change in the Shell's internals, or",
                    "to the parental controls hiding the Settings app, in",
                    "which case this warning can be safely ignored, or",
                    "silenced by turning off Settings under Other Results in",
                    "the extension's preferences.")
            }
            return
        }

        // The prototype is shared by all the remote providers, but the calls
        // of the providers other than Settings go straight to the originals:
        // their terms and results are left alone.
        //
        // Settings ignores the previous results of a subsearch, and searches
        // again (cc-search-provider.c), so the panels are searched again too.
        //
        // If adding the panels fails, the wrappers return Settings' own
        // results: the Shell shows no results at all for a provider whose
        // search fails.
        // cf. https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/51.1/js/ui/search.js#L721-741
        const patch = this
        this.#injections.overrideMethod(proto, 'getInitialResultSet',
            original => function (terms, cancellable) {
                const results = original.call(this, terms, cancellable)

                if (this.id !== PROVIDER_ID)
                    return results

                return patch.#augmentResults(this, results, terms, cancellable).catch(e => {
                    console.error(e)
                    return results
                })
            })
        this.#injections.overrideMethod(proto, 'getSubsearchResultSet',
            original => function (previousResults, terms, cancellable) {
                const results = original.call(this, previousResults, terms, cancellable)

                if (this.id !== PROVIDER_ID)
                    return results

                return patch.#augmentResults(this, results, terms, cancellable).catch(e => {
                    console.error(e)
                    return results
                })
            })
    }

    destroy() {
        this.#injections.clear()
        this.#injections = null
        this.#monitor.disconnect(this.#monitorHandlerId)
        this.#monitorHandlerId = null
        this.#monitor = null
        this.#shadowSearch = null
        this.#known.clear()
    }

    /**
     * Resolves with the Settings provider's results, followed by the panels
     * that only match thanks to their untranslated strings.
     *
     * @param {object} provider the Settings provider
     * @param {Promise<string[]>} resultsPromise the provider's own results
     * @param {string[]} terms
     * @param {?Gio.Cancellable} cancellable
     * @returns {Promise<string[]>}
     */
    async #augmentResults(provider, resultsPromise, terms, cancellable) {
        // Destroyed
        if (!this.#shadowSearch)
            return resultsPromise

        const query = terms.join(' ')
        const [results, shadows] = await Promise.all([
            resultsPromise,
            this.#shadowSearch.search(query).then(groups => groups?.flat()),
        ])

        // Destroyed or canceled in the meantime, or no results from
        // ShadowSearch (e.g. its helper didn't answer in time)
        if (!this.#shadowSearch || cancellable?.is_cancelled() || !shadows)
            return results

        // Removing duplicates that were already found by the Settings provider
        const shown = new Set(results)
        const found = shadows.filter(desktopId => {
            const id = settingsPanelId(desktopId)
            return id !== null && !shown.has(id)
        })
        if (found.length === 0)
            return results

        // Removing results in the session's language, from an extra call to the
        // vanilla GLib search, i.e. on the original Desktop files.
        // The Settings provider's results can't be used for this, because GLib
        // also matches panels the Settings provider doesn't.
        // The extra call is cheap, and while the results can technically drift
        // from the shadow search, they don't drift in a meaningful way: a drift
        // can occur when the Desktop files change, which occurs only when the
        // Settings app is updated, and the #onlyKnown filter catches results
        // that have been removed in the meantime.
        const localized = new Set(GioUnix.DesktopAppInfo.search(query).flat())
        const fallback = found
            .filter(desktopId => !localized.has(desktopId))
            .map(settingsPanelId)
        const added = await this.#onlyKnown(provider, fallback, cancellable)

        return added.length > 0 ? [...results, ...added] : results
    }

    /**
     * Resolves with the panels of `ids` that the provider knows.
     *
     * The Shell drops all of a provider's results when GetResultMetas doesn't
     * return a meta for each of them, so only the panels that the provider
     * knows can be added. It knows the panels it was built with, and there can
     * be desktop files for others (e.g. left over from another version).
     *
     * cf. https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/51.1/js/ui/search.js#L266-269
     *
     * @param {object} provider
     * @param {string[]} ids
     * @param {?Gio.Cancellable} cancellable
     * @returns {Promise<string[]>}
     */
    async #onlyKnown(provider, ids, cancellable) {
        const unchecked = ids.filter(id => !this.#known.has(id))
        if (unchecked.length > 0) {
            const metas = await provider.getResultMetas(unchecked, cancellable)

            // Either the provider couldn't be reached (or the search got
            // canceled), or it doesn't know any of them: they're checked again
            // with the next search, as there's no telling which
            if (metas.length === 0)
                return ids.filter(id => this.#known.get(id))

            const metaIds = new Set(metas.map(meta => meta.id))
            for (const id of unchecked)
                this.#known.set(id, metaIds.has(id))
        }

        return ids.filter(id => this.#known.get(id))
    }
}

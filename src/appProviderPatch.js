// Makes the app results of the search come from ShadowSearch, so that they
// match in every language of the preferences.
//
// AppSearchProvider is not extensible (i.e. plugins can't provide their own
// app lists), so it must be monkey-patched. This will conflict with other
// extensions that customize the app search functionality.

import Shell from 'gi://Shell'
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js'
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js'


/**
 * Patches the app search provider so that its results come from a
 * ShadowSearch, until destroyed.
 */
export class AppProviderPatch {
    #shadowSearch
    #injections = new InjectionManager()

    // ShadowSearch's results for the app search in progress
    #prefetched = null

    /** @param {import('./shadowSearch.js').ShadowSearch} shadowSearch */
    constructor(shadowSearch) {
        this.#shadowSearch = shadowSearch

        const patch = this
        this.#injections.overrideMethod(AppDisplay.AppSearchProvider.prototype, 'getInitialResultSet',
            original => function (terms, cancellable) {
                return patch.#getInitialResultSet(this, original, terms, cancellable)
            })
        this.#injections.overrideMethod(Shell.AppSystem, 'search',
            original => query => patch.#search(original, query))
    }

    destroy() {
        this.#injections.clear()
        this.#injections = null
        this.#prefetched = null
        this.#shadowSearch = null
    }

    // The stock getInitialResultSet() [getIRS()] gets its results from
    // Shell.AppSystem.search(), then filters them, sorts them by usage and adds
    // the system actions. It can't be given other results, so both have to get
    // patched:
    // - search() is called synchronously by the stock getIRS(), and
    //   ShadowSearch answers asynchronously, so its results get fetched first,
    //   here in the patched getIRS(), before handing the control off to the
    //   stock getIRS()
    // - the results are kept in #prefetched only while the stock getIRS() runs,
    //   synchronously, so the only search() call that can return them is the
    //   one from the stock getIRS() that gets triggered by this call to the
    //   patched getIRS(); nothing awaits between setting #prefetched and
    //   clearing it at the end of the patched getIRS(), so no other call can
    //   change it in the meantime
    //
    // When it has to wait for parental controls, the stock getIRS() returns
    // without searching, and once they're ready it calls
    // this.getInitialResultSet() again. That's looked up on the prototype, so
    // while the patch is in place it resolves to the patched getIRS() again,
    // which fetches the results again.
    //
    // cf. https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/51.1/js/ui/appDisplay.js#L1801-1831
    async #getInitialResultSet(provider, original, terms, cancellable) {
        const query = terms.join(' ')
        const groups = await this.#shadowSearch?.search(query)

        // Without ShadowSearch's results (e.g. its helper didn't answer in
        // time), this is the stock search
        this.#prefetched = groups ? {query, groups} : null
        try {
            return original.call(provider, terms, cancellable)
        } finally {
            this.#prefetched = null
        }
    }

    #search(original, query) {
        if (this.#prefetched?.query === query)
            return this.#prefetched.groups
        return original.call(Shell.AppSystem, query)
    }
}

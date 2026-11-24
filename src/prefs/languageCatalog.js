// What the preferences know about languages: which ones the installed apps have
// strings in, which ones can be added to the list, and what they're called.

import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import GnomeDesktop from 'gi://GnomeDesktop?version=4.0'

import {gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'

import {DEFAULT, SESSION} from '../languages.js'
import {tryOrNull} from '../utils.js'


const DESKTOP_GROUP = GLib.KEY_FILE_DESKTOP_GROUP

/** A locale name as desktop files use them: a language, then optionally a
 * country and a modifier, e.g. "sr_RS@latin" */
const LOCALE_NAME = /^([a-z]{2,3})(?:_([A-Z]{2}))?(?:@([A-Za-z]+))?$/

/**
 * The installed apps' translations, and the other languages that are known.
 */
export class LanguageCatalog {
    // One per app shown in the overview, with the locales it has strings in
    #appLocales = []
    // The locales that some app has strings in
    #translated = new Set()

    constructor() {
        for (const appInfo of Gio.AppInfo.get_all()) {
            if (!appInfo.should_show())
                continue
            const locales = translatedLocales(appInfo)
            this.#appLocales.push(locales)
            for (const locale of locales)
                this.#translated.add(locale)
        }
    }

    /** The number of apps shown in the overview */
    get appCount() {
        return this.#appLocales.length
    }

    /**
     * Returns the number of apps that have strings in the locale's language.
     * Those that only have strings in a more general variant of the locale (de
     * for de_CH) count too, as GLib falls back to it.
     *
     * @param {string} locale
     * @returns {number}
     */
    countApps(locale) {
        const variants = GLib.get_locale_variants(locale)
        return this.#appLocales.filter(locales => variants.some(variant => locales.has(variant))).length
    }

    /**
     * Returns whether some app has strings in that very locale, rather than
     * only in a more general variant of it.
     *
     * @param {string} locale
     * @returns {boolean}
     */
    hasStrings(locale) {
        return this.#translated.has(locale)
    }

    /**
     * Returns the locales that can be added: those the apps have strings in,
     * and also, so that they can be added before any app has strings in them,
     * the languages of ISO 639-1 and the locales the system knows.
     *
     * @returns {string[]}
     */
    locales() {
        const locales = new Set(isoLanguages())
        // Some desktop files have malformed locale names (pt-br, zh-hans),
        // whose strings GLib never looks up
        for (const locale of [...this.#translated, ...systemLocales()]) {
            if (LOCALE_NAME.test(locale))
                locales.add(locale)
        }
        return [...locales]
    }
}

/** Returns the locales the app's desktop file has strings in */
function translatedLocales(appInfo) {
    const locales = new Set()
    const path = appInfo.get_filename()
    const keyFile = new GLib.KeyFile()
    // Without KEEP_TRANSLATIONS, only the strings of the session's languages
    // are loaded
    if (!path || !tryOrNull(() => keyFile.load_from_file(path, GLib.KeyFileFlags.KEEP_TRANSLATIONS)))
        return locales

    const [keys] = tryOrNull(() => keyFile.get_keys(DESKTOP_GROUP)) ?? [[]]
    for (const key of keys) {
        const locale = key.match(/\[(.+)\]$/)?.[1]
        if (locale)
            locales.add(locale)
    }
    return locales
}

/**
 * Returns the two-letter codes of the ISO 639-1 languages, from the iso-codes
 * package (which GnomeDesktop gets the names of languages from), or none if it
 * can't be read.
 *
 * They come from its list of ISO 639-2, which also has the three-letter codes
 * of the languages that have no two-letter one, and of groups of languages
 * (e.g. "Afro-Asiatic languages").
 */
function isoLanguages() {
    for (const dir of GLib.get_system_data_dirs()) {
        const path = GLib.build_filenamev([dir, 'iso-codes', 'json', 'iso_639-2.json'])
        const [, contents] = tryOrNull(() => GLib.file_get_contents(path)) ?? []
        if (contents) {
            return tryOrNull(() => JSON.parse(new TextDecoder().decode(contents))['639-2']
                .flatMap(language => language.alpha_2 ?? [])) ?? []
        }
    }
    return []
}

/**
 * Returns the locales the system knows, which have the countries' variants of
 * the languages (e.g. fr_CH): the installed ones, and those that glibc
 * supports, from its list where the distribution ships it.
 */
function systemLocales() {
    const names = GnomeDesktop.get_all_locales()
    const [, contents] = tryOrNull(() => GLib.file_get_contents('/usr/share/i18n/SUPPORTED')) ?? []
    // Its lines are a locale name, then its codeset, e.g. "fr_CH.UTF-8 UTF-8"
    if (contents)
        names.push(...new TextDecoder().decode(contents).split('\n').map(line => line.split(' ')[0]))

    return names.map(withoutCodeset)
        // A modifier that only picks the codeset of the euro's sign, which
        // desktop files don't use
        .filter(locale => !locale.endsWith('@euro'))
}

/**
 * Returns the title and subtitle of a language's row.
 *
 * @param {string} language
 * @param {LanguageCatalog} catalog
 * @returns {{title: string, subtitle: string}}
 */
export function describeLanguage(language, catalog) {
    switch (language) {
    case SESSION: {
        // Named by what it is rather than by its language, which is the
        // subtitle, as it follows the session when its language changes
        const locale = sessionLocale()
        return {title: _("Session Language"), subtitle: languageName(locale) ?? locale}
    }
    case DEFAULT:
        return {title: _("Default Language"), subtitle: _("Original language of the apps, usually English")}
    default: {
        const count = catalog.countApps(language)
        return {
            title: languageName(language) ?? language,
            subtitle: count > 0
                // Translators: the numbers of apps that have strings in the
                // language, and of apps installed. The plural form is chosen
                // by the first one.
                ? ngettext("In %d of %d apps", "In %d of %d apps", count).format(count, catalog.appCount)
                : _("Not in any installed app yet"),
        }
    }
    }
}

/**
 * Returns the name of a locale's language in the session's language, e.g.
 * "German (Switzerland)" for de_CH, or null if it isn't known.
 *
 * @param {string} locale
 * @returns {?string}
 */
export function languageName(locale) {
    const [, language, country, modifier] = locale.match(LOCALE_NAME) ?? []
    if (!language)
        return null

    // The country is added here, as get_language_from_locale() leaves it out
    // for a language that has a single locale installed: en_GB would be
    // "English" where en_US is installed. That function still names the
    // modifier, e.g. "Serbian — Latin".
    let name = modifier
        ? GnomeDesktop.get_language_from_locale(`${language}@${modifier}`, null)
        : GnomeDesktop.get_language_from_code(language, null)
    if (name && country) {
        const countryName = GnomeDesktop.get_country_from_code(country, null)
        name = countryName ? `${name} (${countryName})` : null
    }
    return name
}

/** Returns the locale that the session's strings are looked up in first, e.g.
 * "fr_CH" */
function sessionLocale() {
    // e.g. fr_CH.UTF-8, fr_CH, fr.UTF-8, fr and C
    return withoutCodeset(GLib.get_language_names()[0])
}

/** Returns the locale name without its codeset, which desktop files don't use,
 * e.g. "fr_CH" for "fr_CH.UTF-8", or "sr_RS@latin" for "sr_RS.UTF-8@latin" */
function withoutCodeset(name) {
    return name.replace(/\.[^@]*/, '')
}

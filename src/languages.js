// The languages the apps are searched in, as the `languages` key of the
// extension's settings lists them: in order, each one either a locale name
// ("de", "pt_BR", "sr@latin") or one of the markers below.

/** The session's language, whose strings the stock search looks up */
export const SESSION = 'session'

/** The apps' default language (usually English): the strings of the desktop
 * files' keys without a [locale] suffix, which the translations fall back to */
export const DEFAULT = 'default'

/**
 * Returns the languages without duplicates or empty entries, and with the
 * session's language, which is always searched, first if it's missing.
 *
 * The preferences don't let the session's language be removed, but the key can
 * still be changed without them, e.g. with dconf Editor.
 *
 * @param {string[]} languages
 * @returns {string[]}
 */
export function normalizeLanguages(languages) {
    const unique = [...new Set(languages.filter(language => language))]
    return unique.includes(SESSION) ? unique : [SESSION, ...unique]
}

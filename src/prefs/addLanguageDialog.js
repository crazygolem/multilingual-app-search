// The dialog that adds a language to the preferences' list of the languages the
// apps are searched in.

import Adw from 'gi://Adw'
import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import Gtk from 'gi://Gtk'
import Pango from 'gi://Pango'
import {gettext as _, ngettext} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'

import {DEFAULT} from '../languages.js'
import {describeLanguage, formatNumbers, languageName} from './languageCatalog.js'

/**
 * Lists the languages that can be added to the list: those the installed apps
 * have strings in, then the other ones the catalog knows on demand or when
 * searched for. A search that spells a locale name that isn't listed, e.g.
 * "de_FR", offers that one.
 *
 * The session's language is offered like any other: the list's row for the
 * session follows it when it changes, while a language added here stays.
 */
export const AddLanguageDialog = GObject.registerClass(
class AddLanguageDialog extends Adw.Dialog {
    #catalog
    #onAdd
    // The languages that a search can't offer, as they're in the list already
    // or have a row in the dialog
    #taken
    #searchEntry
    #list
    // The language of each row, with what it's searched by
    #rowLanguages = new Map()
    // Where each language's row goes, the languages being sorted by name
    #positions = new Map()
    // The languages that are only listed once the others are shown, whose rows
    // are only created then, as there are hundreds of them
    #unlisted = []
    #moreRow = null
    #showAll = false
    // The row of the locale name that the search spells, if any
    #searchedRow = null
    #countLabels = new Gtk.SizeGroup({mode: Gtk.SizeGroupMode.HORIZONTAL})

    /**
     * @param {import('./languageCatalog.js').LanguageCatalog} catalog
     * @param {string[]} added the languages already in the list
     * @param {(language: string) => void} onAdd called with the language to add
     */
    constructor(catalog, added, onAdd) {
        super({title: _("Add Language"), content_width: 460, content_height: 600})
        this.#catalog = catalog
        this.#onAdd = onAdd

        this.#searchEntry = new Gtk.SearchEntry({placeholder_text: _("Search languages"), hexpand: true})
        this.#searchEntry.connect('search-changed', () => this.#updateSearch())
        this.#searchEntry.connect('activate', () => this.#activateFirstMatch())
        const searchBar = new Gtk.SearchBar({
            child: new Adw.Clamp({child: this.#searchEntry, maximum_size: 440}),
            search_mode_enabled: true,
            key_capture_widget: this,
        })
        searchBar.connect_entry(this.#searchEntry)

        this.#list = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            valign: Gtk.Align.START,
            css_classes: ['boxed-list'],
        })
        this.#list.set_placeholder(new Gtk.Label({
            label: _("No languages found"),
            margin_top: 18,
            margin_bottom: 18,
            css_classes: ['dim-label'],
        }))
        this.#list.set_filter_func(row => this.#isShown(row))
        this.#list.set_sort_func((a, b) => this.#position(a) - this.#position(b))
        this.#list.connect('row-activated', (_list, row) => this.#activate(row))

        this.#taken = new Set(added)
        if (!added.includes(DEFAULT)) {
            this.#positions.set(DEFAULT, -1)
            this.#list.append(this.#createRow(DEFAULT))
        }

        const offered = catalog.locales()
            .filter(locale => !this.#taken.has(locale))
            .map(locale => ({locale, name: languageName(locale) ?? locale}))
            .sort((a, b) => a.name.localeCompare(b.name))
        offered.forEach(({locale}, index) => {
            this.#taken.add(locale)
            this.#positions.set(locale, index)
            // Listed when some app has strings in that very locale, rather
            // than in a more general one: de_CH counts the apps that have de
            // strings, like every country's variant of German does
            if (catalog.hasStrings(locale))
                this.#list.append(this.#createRow(locale))
            else
                this.#unlisted.push(locale)
        })

        if (this.#unlisted.length > 0) {
            this.#moreRow = new Gtk.ListBoxRow({
                child: new Gtk.Image({icon_name: 'view-more-symbolic', margin_top: 14, margin_bottom: 14}),
                tooltip_text: _("More Languages"),
            })
            this.#moreRow.update_property([Gtk.AccessibleProperty.LABEL], [_("More Languages")])
            this.#list.append(this.#moreRow)
        }

        const toolbarView = new Adw.ToolbarView({
            content: new Gtk.ScrolledWindow({
                child: new Adw.Clamp({
                    child: this.#list,
                    maximum_size: 440,
                    margin_top: 6,
                    margin_bottom: 18,
                    margin_start: 12,
                    margin_end: 12,
                }),
                hscrollbar_policy: Gtk.PolicyType.NEVER,
                vexpand: true,
            }),
        })
        toolbarView.add_top_bar(new Adw.HeaderBar())
        toolbarView.add_top_bar(searchBar)
        this.child = toolbarView
        // Setting focus_widget here has no effect, as the entry can't be
        // focused before the dialog is in a window
        this.connect('map', () => this.#searchEntry.grab_focus())
    }

    #createRow(language) {
        if (language === DEFAULT) {
            const {title, subtitle} = describeLanguage(language, this.#catalog)
            const row = new Adw.ActionRow({title, subtitle, use_markup: false, activatable: true})
            // "English" finds it too
            this.#rowLanguages.set(row, {language, listed: true, searchText: `${title} ${subtitle}`})
            return row
        }

        const name = languageName(language)
        const row = new Adw.ActionRow({title: name ?? language, use_markup: false, activatable: true})
        // The locale name, unless it's the title already. It has the same
        // width in every row, which fits most locale names, so that the
        // columns line up.
        if (name) {
            row.add_suffix(new Gtk.Label({
                label: language,
                tooltip_text: language,
                xalign: 0,
                width_chars: 8,
                max_width_chars: 8,
                ellipsize: Pango.EllipsizeMode.END,
                css_classes: ['dim-label'],
            }))
        }

        const count = this.#catalog.countApps(language)
        const apps = new Gtk.Label({
            label: count > 0 ? formatNumbers(ngettext("%d app", "%d apps", count), count) : _("No apps"),
            xalign: 1,
            css_classes: ['dim-label', 'numeric'],
        })
        this.#countLabels.add_widget(apps)
        row.add_suffix(apps)

        const listed = this.#catalog.hasStrings(language)
        this.#rowLanguages.set(row, {language, listed, searchText: name ?? language})
        return row
    }

    #createUnlistedRows() {
        for (const locale of this.#unlisted)
            this.#list.append(this.#createRow(locale))
        this.#unlisted = []
    }

    // The searched row comes first, then the default language, the others by
    // name, and the row that shows them all last
    #position(row) {
        if (row === this.#searchedRow)
            return -2
        if (row === this.#moreRow)
            return this.#positions.size
        return this.#positions.get(this.#rowLanguages.get(row).language)
    }

    #isShown(row) {
        const text = this.#searchEntry.text.trim()
        if (row === this.#moreRow)
            return !text && !this.#showAll

        if (row === this.#searchedRow)
            return true

        const {language, listed, searchText} = this.#rowLanguages.get(row)
        if (text) {
            return GLib.str_match_string(text, searchText, true) ||
                language.toLowerCase().startsWith(text.toLowerCase().replaceAll('-', '_'))
        }
        return listed || this.#showAll
    }

    #updateSearch() {
        if (this.#searchedRow) {
            this.#list.remove(this.#searchedRow)
            this.#rowLanguages.delete(this.#searchedRow)
            this.#searchedRow = null
        }

        // A search finds every language
        if (this.#searchEntry.text.trim())
            this.#createUnlistedRows()

        const locale = localeFromSearch(this.#searchEntry.text)
        if (locale && !this.#taken.has(locale) && languageName(locale)) {
            this.#searchedRow = this.#createRow(locale)
            this.#list.prepend(this.#searchedRow)
        }
        this.#list.invalidate_filter()
    }

    #activate(row) {
        if (row === this.#moreRow) {
            this.#showAll = true
            this.#createUnlistedRows()
            this.#list.invalidate_filter()
            // The row that had the focus is now hidden
            this.#searchEntry.grab_focus()
            return
        }

        this.#onAdd(this.#rowLanguages.get(row).language)
        this.close()
    }

    #activateFirstMatch() {
        for (let i = 0, row; (row = this.#list.get_row_at_index(i)); i++) {
            if (row !== this.#moreRow && row.get_child_visible()) {
                this.#activate(row)
                return
            }
        }
    }
})

/**
 * Returns the locale name that a search spells, e.g. "de_AT" for "de-at", or
 * null if it doesn't spell one.
 *
 * @param {string} text
 * @returns {?string}
 */
function localeFromSearch(text) {
    const [, language, country, modifier] =
        text.trim().match(/^([a-z]{2,3})(?:[_-]([a-z]{2}))?(?:@([a-z]+))?$/i) ?? []
    if (!language)
        return null
    return language.toLowerCase() +
        (country ? `_${country.toUpperCase()}` : '') +
        (modifier ? `@${modifier}` : '')
}

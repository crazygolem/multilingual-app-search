// The preferences' list of the languages the apps are searched in, which can
// be reordered.

import Adw from 'gi://Adw'
import Gdk from 'gi://Gdk'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import Gtk from 'gi://Gtk'
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'

import {SESSION, normalizeLanguages} from '../languages.js'
import {AddLanguageDialog} from './addLanguageDialog.js'
import {LanguageCatalog, describeLanguage} from './languageCatalog.js'

/**
 * The list of the languages the apps are searched in, from the `languages` key
 * of the settings, which every change made with it is written to. The rows can
 * be reordered by dragging them or with their menu, and every language but the
 * session's can be removed.
 */
export const LanguagesGroup = GObject.registerClass(
class LanguagesGroup extends Adw.PreferencesGroup {
    #settings
    #catalog = new LanguageCatalog()
    // A list of its own rather than the group's, so that the rows can be
    // inserted before the one that adds languages, which keeps the focus when
    // the rows get rebuilt after the dialog adds one
    #list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']})
    // One per language, in order: {language, row, menuButton}
    #entries = []
    #rebuildSourceId = null
    // The language whose menu gets the focus once the rows are rebuilt
    #focusAfterRebuild = null

    /** @param {Gio.Settings} settings the extension's settings */
    constructor(settings) {
        super({
            title: _("Languages"),
            description: _("When a query matches equally well in several languages, the one higher in the list ranks first."),
        })
        this.#settings = settings
        this.#list.append(this.#createAddRow())
        this.add(this.#list)

        // GSettings only reports changes to a key that was read while a
        // handler was connected, so the handler gets connected first
        const handlerId = settings.connect('changed::languages', () => this.#scheduleRebuild())
        this.connect('destroy', () => {
            settings.disconnect(handlerId)
            if (this.#rebuildSourceId !== null)
                GLib.source_remove(this.#rebuildSourceId)
            this.#rebuildSourceId = null
        })
        this.#rebuild()
    }

    get #languages() {
        return normalizeLanguages(this.#settings.get_strv('languages'))
    }

    #write(languages) {
        this.#settings.set_strv('languages', languages)
    }

    #moveBy(language, offset) {
        const languages = this.#languages
        const from = languages.indexOf(language)
        this.#moveTo(language, languages[from + offset])
    }

    /** Moves `language` to where `target` is, which shifts `target` by one */
    #moveTo(language, target) {
        const languages = this.#languages
        const from = languages.indexOf(language)
        const to = languages.indexOf(target)
        if (from === -1 || to === -1 || from === to)
            return

        languages.splice(from, 1)
        languages.splice(to, 0, language)
        this.#write(languages)
    }

    // The rows are rebuilt once the main loop is idle rather than right away,
    // as the change can come from a row's own menu, whose popover is still
    // closing when its action gets activated
    #scheduleRebuild() {
        if (this.#rebuildSourceId !== null)
            return

        this.#rebuildSourceId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.#rebuildSourceId = null
            this.#rebuild()
            return GLib.SOURCE_REMOVE
        })
    }

    #rebuild() {
        for (const {row} of this.#entries)
            this.#list.remove(row)

        const languages = this.#languages
        this.#entries = languages.map((language, index) =>
            this.#createRow(language, index === 0, index === languages.length - 1))
        this.#entries.forEach(({row}, index) => this.#list.insert(row, index))

        // Keeps the focus in the list after a change from the keyboard: on the
        // moved row, so that it can be moved again, or next to the removed one
        const focused = this.#entries.find(({language}) => language === this.#focusAfterRebuild)
        focused?.menuButton.grab_focus()
        this.#focusAfterRebuild = null
    }

    #createRow(language, isFirst, isLast) {
        const row = new Adw.ActionRow({use_markup: false, ...describeLanguage(language, this.#catalog)})
        row.add_prefix(new Gtk.Image({
            icon_name: 'list-drag-handle-symbolic',
            accessible_role: Gtk.AccessibleRole.PRESENTATION,
        }))

        const actions = new Gio.SimpleActionGroup()
        const addAction = (name, enabled, activate) => {
            const action = new Gio.SimpleAction({name, enabled})
            action.connect('activate', activate)
            actions.add_action(action)
        }
        addAction('move-up', !isFirst, () => {
            this.#focusAfterRebuild = language
            this.#moveBy(language, -1)
        })
        addAction('move-down', !isLast, () => {
            this.#focusAfterRebuild = language
            this.#moveBy(language, 1)
        })
        // The session's language is always searched
        addAction('remove', language !== SESSION, () => {
            const languages = this.#languages
            const index = languages.indexOf(language)
            this.#focusAfterRebuild = languages[index + 1] ?? languages[index - 1]
            this.#write(languages.filter(other => other !== language))
        })
        row.insert_action_group('row', actions)

        const menu = new Gio.Menu()
        menu.append(_("Move Up"), 'row.move-up')
        menu.append(_("Move Down"), 'row.move-down')
        if (language !== SESSION) {
            const removeSection = new Gio.Menu()
            removeSection.append(_("Remove"), 'row.remove')
            menu.append_section(null, removeSection)
        }
        const menuButton = new Gtk.MenuButton({
            icon_name: 'view-more-symbolic',
            menu_model: menu,
            tooltip_text: _("More Options"),
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        })
        row.add_suffix(menuButton)

        this.#makeDraggable(row, language)
        return {language, row, menuButton}
    }

    // A row can be dropped on another one, and then takes its place
    #makeDraggable(row, language) {
        let hotspot = [0, 0]
        const dragSource = new Gtk.DragSource({actions: Gdk.DragAction.MOVE})
        dragSource.connect('prepare', (_source, x, y) => {
            hotspot = [x, y]
            return Gdk.ContentProvider.new_for_value(row)
        })
        dragSource.connect('drag-begin', (_source, drag) => {
            // A copy of the row, in a list of its own so that it's styled
            // like it
            const copy = new Adw.ActionRow({use_markup: false, ...describeLanguage(language, this.#catalog)})
            copy.add_prefix(new Gtk.Image({icon_name: 'list-drag-handle-symbolic'}))
            copy.add_suffix(new Gtk.Image({icon_name: 'view-more-symbolic', margin_start: 8, margin_end: 8}))
            const list = new Gtk.ListBox({
                css_classes: ['boxed-list'],
                width_request: row.get_width(),
                height_request: row.get_height(),
            })
            list.append(copy)
            Gtk.DragIcon.get_for_drag(drag).set_child(list)
            drag.set_hotspot(...hotspot)
        })
        row.add_controller(dragSource)

        const dropTarget = Gtk.DropTarget.new(Adw.ActionRow.$gtype, Gdk.DragAction.MOVE)
        dropTarget.connect('drop', (_target, source) => {
            const dragged = this.#entries.find(entry => entry.row === source)
            if (!dragged)
                return false
            this.#moveTo(dragged.language, language)
            return true
        })
        row.add_controller(dropTarget)
    }

    #createAddRow() {
        const row = new Adw.ActionRow({title: _("Add Language…"), activatable: true})
        row.add_prefix(new Gtk.Image({icon_name: 'list-add-symbolic'}))
        row.connect('activated', () => {
            const dialog = new AddLanguageDialog(this.#catalog, this.#languages,
                language => this.#write([...this.#languages, language]))
            dialog.present(this)
        })
        return row
    }
})

import Adw from 'gi://Adw'
import Gio from 'gi://Gio'

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'

import {LanguagesGroup} from './prefs/languagesGroup.js'


export default class MultilingualAppSearchPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings()

        const group = new Adw.PreferencesGroup({title: _("Other Results")})

        const settingsPanels = new Adw.SwitchRow({
            // Translators: "Settings" is the name of the Settings app, whose
            // panels are Wi-Fi, Bluetooth, Displays, ...
            title: _("Settings"),
            subtitle: _("Augment search results from the Settings application, finding extra panels by their name and keywords."),
        })
        settings.bind('handle-settings-provider', settingsPanels, 'active', Gio.SettingsBindFlags.DEFAULT)
        group.add(settingsPanels)

        const page = new Adw.PreferencesPage()
        page.add(new LanguagesGroup(settings))
        page.add(group)
        window.add(page)
    }
}

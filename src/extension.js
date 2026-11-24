import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js'

import {normalizeLanguages} from './languages.js'
import {AppProviderPatch} from './shell/appProviderPatch.js'
import {SettingsProviderPatch} from './shell/settingsProviderPatch.js'
import {ShadowSearch} from './shell/shadowSearch.js'


export default class BilingualAppSearch extends Extension {
    #settings
    #settingsHandlerIds
    #shadowSearch
    #appProviderPatch
    #settingsProviderPatch = null

    enable() {
        this.#settings = this.getSettings()

        // The languages and the Settings panels can be changed in the
        // preferences while the extension is enabled. GSettings only reports
        // changes to a key that was read while a handler was connected, so the
        // handlers get connected first.
        this.#settingsHandlerIds = [
            this.#settings.connect('changed::languages',
                () => this.#shadowSearch.setLanguages(this.#languages())),
            this.#settings.connect('changed::handle-settings-provider',
                () => this.#syncSettingsProviderPatch()),
        ]

        this.#shadowSearch = new ShadowSearch(this.uuid, this.#languages())
        this.#appProviderPatch = new AppProviderPatch(this.#shadowSearch)
        this.#syncSettingsProviderPatch()
    }

    disable() {
        for (const id of this.#settingsHandlerIds)
            this.#settings.disconnect(id)
        this.#settingsHandlerIds = null
        this.#settings = null
        this.#settingsProviderPatch?.destroy()
        this.#settingsProviderPatch = null
        this.#appProviderPatch.destroy()
        this.#appProviderPatch = null
        this.#shadowSearch.destroy()
        this.#shadowSearch = null
    }

    #languages() {
        return normalizeLanguages(this.#settings.get_strv('languages'))
    }

    // Patches Settings' search provider, or undoes the patch, according to the
    // preferences
    #syncSettingsProviderPatch() {
        const wanted = this.#settings.get_boolean('handle-settings-provider')
        if (wanted && !this.#settingsProviderPatch) {
            this.#settingsProviderPatch = new SettingsProviderPatch(this.#shadowSearch, this.uuid)
        } else if (!wanted && this.#settingsProviderPatch) {
            this.#settingsProviderPatch.destroy()
            this.#settingsProviderPatch = null
        }
    }
}

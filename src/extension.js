import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js'

import {AppProviderPatch} from './appProviderPatch.js'
import {SettingsProviderPatch} from './settingsProviderPatch.js'
import {ShadowSearch} from './shadowSearch.js'


export default class BilingualAppSearch extends Extension {
    #settings
    #settingsHandlerId
    #shadowSearch
    #appProviderPatch
    #settingsProviderPatch = null

    enable() {
        this.#settings = this.getSettings()
        this.#shadowSearch = new ShadowSearch(this.uuid)
        this.#appProviderPatch = new AppProviderPatch(this.#shadowSearch)

        // The Settings panels can be turned on and off in the preferences
        // while the extension is enabled. GSettings only reports changes to a
        // key that was read while a handler was connected, so the handler gets
        // connected first.
        this.#settingsHandlerId = this.#settings.connect('changed::handle-settings-provider',
            () => this.#syncSettingsProviderPatch())
        this.#syncSettingsProviderPatch()
    }

    disable() {
        this.#settings.disconnect(this.#settingsHandlerId)
        this.#settingsHandlerId = null
        this.#settings = null
        this.#settingsProviderPatch?.destroy()
        this.#settingsProviderPatch = null
        this.#appProviderPatch.destroy()
        this.#appProviderPatch = null
        this.#shadowSearch.destroy()
        this.#shadowSearch = null
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

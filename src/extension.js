import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js'

import {AppProviderPatch} from './appProviderPatch.js'
import {SettingsProviderPatch} from './settingsProviderPatch.js'
import {ShadowSearch} from './shadowSearch.js'


export default class BilingualAppSearch extends Extension {
    #shadowSearch
    #appProviderPatch
    #settingsProviderPatch

    enable() {
        this.#shadowSearch = new ShadowSearch(this.uuid)
        this.#appProviderPatch = new AppProviderPatch(this.#shadowSearch)
        this.#settingsProviderPatch = new SettingsProviderPatch(this.#shadowSearch, this.uuid)
    }

    disable() {
        this.#settingsProviderPatch.destroy()
        this.#settingsProviderPatch = null
        this.#appProviderPatch.destroy()
        this.#appProviderPatch = null
        this.#shadowSearch.destroy()
        this.#shadowSearch = null
    }
}

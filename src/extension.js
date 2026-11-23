import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js'

import {AppProviderPatch} from './appProviderPatch.js'
import {ShadowSearch} from './shadowSearch.js'


export default class BilingualAppSearch extends Extension {
    #shadowSearch
    #appProviderPatch

    enable() {
        this.#shadowSearch = new ShadowSearch(this.uuid)
        this.#appProviderPatch = new AppProviderPatch(this.#shadowSearch)
    }

    disable() {
        this.#appProviderPatch.destroy()
        this.#appProviderPatch = null
        this.#shadowSearch.destroy()
        this.#shadowSearch = null
    }
}

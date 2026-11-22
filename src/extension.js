import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Shell from 'gi://Shell'
import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js'

import {SearchHelper, ShadowAppDir} from './bilingualSearch.js'
import {listDir, removeTree} from './utils.js'


export default class BilingualAppSearch extends Extension {
    #runtimeDir
    #shadowAppDir
    #helper
    #originalGetInitialResultSet
    #originalSearch

    // The helper's results for the app search in progress, see
    // #getInitialResultSet()
    #prefetched = null

    enable() {
        this.#runtimeDir = makeProcessDir(GLib.build_filenamev([GLib.get_user_runtime_dir(), this.uuid]))
        const dataDir = GLib.build_filenamev([this.#runtimeDir, 'share'])
        // The helper's only system data directory, so that the copies are the
        // only desktop files it sees
        const emptyDir = GLib.build_filenamev([this.#runtimeDir, 'empty'])
        GLib.mkdir_with_parents(emptyDir, 0o700)

        this.#shadowAppDir = new ShadowAppDir(GLib.build_filenamev([dataDir, 'applications']))
        this.#helper = new SearchHelper(
            ['gjs', '-m', GLib.build_filenamev([this.path, 'searchHelper.js'])],
            {LANGUAGE: 'C', XDG_DATA_HOME: dataDir, XDG_DATA_DIRS: emptyDir},
            this.uuid
        )

        // AppSearchProvider is not extensible (i.e. plugins can't provide their
        // own app lists), so it must be monkey-patched. This will conflict with
        // other extensions that customize the app search functionality.
        const extension = this
        // The wrappers call the originals they captured, not the fields, which
        // disable() clears: a wrapper can still get called after that, e.g. by
        // another extension that patched the same function after this one.
        const getInitialResultSet = AppDisplay.AppSearchProvider.prototype.getInitialResultSet
        this.#originalGetInitialResultSet = getInitialResultSet
        AppDisplay.AppSearchProvider.prototype.getInitialResultSet = function (terms, cancellable) {
            return extension.#getInitialResultSet(this, getInitialResultSet, terms, cancellable)
        }

        const search = Shell.AppSystem.search
        this.#originalSearch = search
        Shell.AppSystem.search = query => this.#search(search, query)
    }

    disable() {
        Shell.AppSystem.search = this.#originalSearch
        this.#originalSearch = null
        AppDisplay.AppSearchProvider.prototype.getInitialResultSet = this.#originalGetInitialResultSet
        this.#originalGetInitialResultSet = null
        this.#prefetched = null

        this.#helper.destroy()
        this.#helper = null
        this.#shadowAppDir.destroy()
        this.#shadowAppDir = null
        removeTree(this.#runtimeDir)
        this.#runtimeDir = null
    }

    // The stock getInitialResultSet() [getIRS()] gets its results from
    // Shell.AppSystem.search(), then filters them, sorts them by usage and adds
    // the system actions. It can't be given other results, so both have to get
    // patched:
    // - search() is called synchronously by the stock getIRS(), and the helper
    //   answers asynchronously, so its results get fetched first, here in the
    //   patched getIRS(), before handing the control off to the stock getIRS()
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
    // while the extension is enabled it resolves to the patched getIRS() again,
    // which fetches the results again.
    //
    // cf. https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/51.1/js/ui/appDisplay.js#L1801-1831
    async #getInitialResultSet(provider, original, terms, cancellable) {
        this.#shadowAppDir?.scheduleCheck()

        const query = terms.join(' ')
        const groups = await this.#helper?.search(query)

        // Without the helper's results (e.g. it didn't answer in time), this
        // is the stock search
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

/**
 * Creates an empty directory for this process in `parent`, after deleting
 * those of processes that don't run anymore (e.g. a shell that crashed), and
 * returns its path.
 *
 * Several GNOME Shell processes of the same user can run the extension at the
 * same time, e.g. a nested shell started for development, and they share the
 * runtime directory. Each one keeps its files in a directory of its own, so
 * that they don't delete or overwrite each other's.
 */
function makeProcessDir(parent) {
    const pid = new Gio.Credentials().get_unix_pid()

    // Without /proc, there's no telling which processes still run
    const canCheck = GLib.file_test('/proc/self', GLib.FileTest.EXISTS)

    for (const name of listDir(parent)) {
        if (!/^[0-9]+$/.test(name))
            continue

        const isDead = canCheck && !GLib.file_test(`/proc/${name}`, GLib.FileTest.EXISTS)
        if (isDead || Number(name) === pid)
            removeTree(GLib.build_filenamev([parent, name]))
    }

    const dir = GLib.build_filenamev([parent, String(pid)])
    GLib.mkdir_with_parents(dir, 0o700)
    return dir
}

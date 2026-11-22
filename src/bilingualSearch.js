// Searches apps with GLib's own search function, the one stock GNOME Shell
// uses, in both the localized and the untranslated strings of their desktop
// files.
//
// GLib only searches the strings of the locale it takes from the process'
// environment, and the shell's environment can't be changed. So the search
// runs in a separate process (searchHelper.js) without a locale, on copies of
// the desktop files in which each translated string holds both languages.
//
// Only GLib and Gio are imported, here and in utils.js, so this module also
// loads in a plain `gjs -m`.

import Gio from 'gi://Gio'
import GLib from 'gi://GLib'

import {listDir, removeTree, tryOrNull, withTimeout} from './utils.js'

const DESKTOP_GROUP = 'Desktop Entry'

/** How long a search waits for the helper before giving up */
const SEARCH_TIMEOUT_MS = 500

/** How long the helper can leave a search unanswered before it's considered
 * stuck and gets stopped */
const STUCK_AFTER_US = 2 * GLib.USEC_PER_SEC

/** Size of the queries sent to the helper and not answered yet, beyond which
 * searches don't wait for it. Far below the capacity of the pipe (64 KiB on
 * Linux), so that writing a query never blocks the shell. */
const MAX_PENDING_BYTES = 16 * 1024

/** Minimum time between two starts of the helper, so that a helper that keeps
 * failing doesn't get restarted with every keystroke */
const RESTART_DELAY_US = 10 * GLib.USEC_PER_SEC

/** Minimum time between two checks for apps that appeared or disappeared
 * without a change to their desktop files, see ShadowAppDir.scheduleCheck() */
const CHECK_INTERVAL_US = 5 * GLib.USEC_PER_SEC

/**
 * Returns the contents of a copy of the app's desktop file, keeping only its
 * main group, in which every value that has a translation for the current
 * locale is replaced by "<localized>;<untranslated>". Or null if the app
 * doesn't come from a desktop file that can be read.
 *
 * The localized value is read in the shell's locale, like stock search does.
 * It comes first so that queries in the localized language rank like with
 * stock search, since GLib also ranks matches by their position in the value.
 * Every key gets combined, not only the ones GLib searches, so that this keeps
 * working if GLib starts searching other keys. The keys GLib uses otherwise,
 * like Exec or TryExec, are never translated, and are copied as they are.
 */
function combineTranslations(appInfo) {
    const path = appInfo.get_filename?.()
    if (!path)
        return null

    const source = new GLib.KeyFile()
    if (!tryOrNull(() => source.load_from_file(path, GLib.KeyFileFlags.NONE)))
        return null

    if (!source.has_group(DESKTOP_GROUP))
        return null

    const copy = new GLib.KeyFile()
    const [keys] = source.get_keys(DESKTOP_GROUP)
    for (const key of keys) {
        // Translations, folded into their key
        if (key.includes('['))
            continue

        const localized = tryOrNull(() => source.get_locale_string(DESKTOP_GROUP, key, null))
        const untranslated = tryOrNull(() => source.get_string(DESKTOP_GROUP, key))
        if (localized !== null && untranslated !== null && localized !== untranslated)
            copy.set_string(DESKTOP_GROUP, key, `${localized};${untranslated}`)
        else
            copy.set_value(DESKTOP_GROUP, key, source.get_value(DESKTOP_GROUP, key))
    }

    return copy.to_data()[0]
}

/**
 * An `applications` directory that shadows the installed apps: it holds a copy
 * of the desktop file of each one, with both languages in each translated value
 * (see combineTranslations), and gets updated when apps are installed, removed
 * or changed.
 */
export class ShadowAppDir {
    #dir
    #written = new Map()
    // Kept, as Gio.AppInfoMonitor.get() returns a new monitor once the
    // previous one is finalized, which would drop the handler
    #monitor = Gio.AppInfoMonitor.get()
    #monitorHandlerId
    // The desktop IDs returned by get_all() for the last update
    #appIds = new Set()
    // When the copies were last updated, or checked to be up to date
    #lastCheck = null
    #checkSourceId = null

    /**
     * @param {string} dir the directory where the shadow copies are kept.
     */
    constructor(dir) {
        this.#dir = dir
        GLib.mkdir_with_parents(dir, 0o700)

        this.#monitorHandlerId = this.#monitor.connect('changed', () => this.#update())
        this.#update()
    }

    destroy() {
        if (this.#checkSourceId !== null)
            GLib.source_remove(this.#checkSourceId)
        this.#checkSourceId = null
        this.#monitor.disconnect(this.#monitorHandlerId)
        this.#monitorHandlerId = null
        this.#monitor = null
        this.#removeAll()
        this.#written = null
    }

    /**
     * Updates the copies soon if apps appeared or disappeared without a change
     * to their desktop files, which Gio.AppInfoMonitor doesn't report, e.g. an
     * app whose TryExec program got installed.
     *
     * This is meant to be called with each search, and the check happens after
     * it, when the main loop is idle, so the search that triggers it doesn't
     * see the change yet, but the next ones do. It's done at most once every
     * few seconds, as get_all() parses every desktop file.
     */
    scheduleCheck() {
        if (this.#checkSourceId !== null ||
            GLib.get_monotonic_time() - this.#lastCheck < CHECK_INTERVAL_US)
            return

        this.#checkSourceId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this.#checkSourceId = null

            const appInfos = Gio.AppInfo.get_all()
            const changed = appInfos.length !== this.#appIds.size ||
                appInfos.some(appInfo => !this.#appIds.has(appInfo.get_id()))
            if (changed)
                this.#update(appInfos)
            else
                this.#lastCheck = GLib.get_monotonic_time()

            return GLib.SOURCE_REMOVE
        })
    }

    // Only writes the files that changed, since GLib rescans the directory
    // after every change
    #update(appInfos = Gio.AppInfo.get_all()) {
        this.#lastCheck = GLib.get_monotonic_time()
        this.#appIds = new Set(appInfos.map(appInfo => appInfo.get_id()))
        const current = new Map()

        // Apps that shouldn't be shown (NoDisplay, OnlyShowIn, ...) get copied
        // too: GLib's search returns them like any other app, for stock search
        // as well, and the shell filters the results with the original desktop
        // files (AppSearchProvider.getInitialResultSet() and should_show()).
        //
        // get_all() leaves out the apps whose TryExec program can't be found,
        // where GLib's search index doesn't. If the program appears later
        // without a desktop file changing, stock search finds the app right
        // away, but this only does after scheduleCheck() noticed it.
        for (const appInfo of appInfos) {
            const id = appInfo.get_id()
            const contents = id ? combineTranslations(appInfo) : null
            if (contents !== null)
                current.set(id, contents)
        }

        for (const id of this.#written.keys()) {
            if (!current.has(id))
                GLib.unlink(this.#path(id))
        }

        const written = new Map()
        let error = null
        for (const [id, contents] of current) {
            try {
                if (this.#written.get(id) !== contents)
                    GLib.file_set_contents(this.#path(id), contents)
                written.set(id, contents)
            } catch (e) {
                error ??= e
            }
        }
        if (error)
            console.error(error)

        this.#written = written
    }

    // An app's desktop ID is the name of its desktop file, with the
    // subdirectories it's in prefixed, so writing the copy at the root of the
    // directory gives it the same desktop ID.
    #path(id) {
        return GLib.build_filenamev([this.#dir, id])
    }

    #removeAll() {
        for (const name of listDir(this.#dir))
            removeTree(GLib.build_filenamev([this.#dir, name]))
    }
}

/**
 * Runs searchHelper.js in a process of its own, and passes it the searches.
 * The process gets restarted when needed, by the next search after it exited
 * or got stuck.
 */
export class SearchHelper {
    #argv
    #environment
    #logPrefix
    #process = null
    #stdin = null
    #stdout = null
    #cancellable = null
    #lastStart = null
    #destroyed = false

    // The searches sent to the process, in the order they were sent, which is
    // also the order of the replies: {resolve, sentAt, size}. A search that
    // timed out stays here until its reply arrives.
    #pending = []
    #pendingSize = 0

    /**
     * @param {string[]} argv the command that runs searchHelper.js
     * @param {Object<string, string>} environment variables to set for it
     * @param {string} logPrefix for the messages logged about it
     */
    constructor(argv, environment, logPrefix) {
        this.#argv = argv
        this.#environment = environment
        this.#logPrefix = logPrefix
        this.#start()
    }

    destroy() {
        this.#destroyed = true
        this.#stop()
    }

    /**
     * Resolves with GLib's result groups for the query, like
     * Shell.AppSystem.search() returns, or with null if the helper can't
     * answer in time.
     *
     * @param {string} query
     * @returns {Promise<?string[][]>}
     */
    search(query) {
        const now = GLib.get_monotonic_time()
        if (this.#pending.length > 0 && now - this.#pending[0].sentAt > STUCK_AFTER_US)
            this.#stop(`the search helper did not answer for ${STUCK_AFTER_US / GLib.USEC_PER_SEC} seconds`)

        if (!this.#process && !this.#start())
            return Promise.resolve(null)

        const line = new TextEncoder().encode(`${query.replaceAll('\n', ' ')}\n`)
        if (this.#pendingSize + line.length > MAX_PENDING_BYTES)
            return Promise.resolve(null)

        const reply = new Promise(resolve => {
            this.#pending.push({resolve, sentAt: now, size: line.length})
            this.#pendingSize += line.length
        })
        try {
            this.#stdin.write_all(line, null)
        } catch (e) {
            // Resolves the reply with null
            this.#stop(`could not send a search to the search helper: ${e.message}`)
        }

        return withTimeout(reply, SEARCH_TIMEOUT_MS)
    }

    #start() {
        if (this.#destroyed)
            return false

        const now = GLib.get_monotonic_time()
        if (this.#lastStart !== null && now - this.#lastStart < RESTART_DELAY_US)
            return false
        this.#lastStart = now

        let process
        try {
            const launcher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
            })
            for (const [name, value] of Object.entries(this.#environment))
                launcher.setenv(name, value, true)
            process = launcher.spawnv(this.#argv)
        } catch (e) {
            console.warn(`${this.#logPrefix}: could not start the search helper: ${e.message}`)
            return false
        }

        this.#process = process
        this.#cancellable = new Gio.Cancellable()
        this.#stdin = process.get_stdin_pipe()
        this.#stdout = new Gio.DataInputStream({base_stream: process.get_stdout_pipe()})

        // The callbacks compare the process they were set up for with the
        // current one, to ignore those of a process that got stopped (and maybe
        // replaced by a new one) in the meantime
        process.wait_async(this.#cancellable, (_, result) => {
            // Throws if canceled, by #stop()
            if (tryOrNull(() => process.wait_finish(result)) && this.#process === process)
                this.#stop(`the search helper exited${this.#exitStatus(process)}`)
        })
        this.#readReply(process)

        return true
    }

    #readReply(process) {
        this.#stdout.read_line_async(GLib.PRIORITY_DEFAULT, this.#cancellable, (stream, result) => {
            // Stopped in the meantime
            if (this.#process !== process)
                return

            let line
            try {
                [line] = stream.read_line_finish_utf8(result)
            } catch (e) {
                this.#stop(`could not read from the search helper: ${e.message}`)
                return
            }

            // The process exited, which wait_async() reports with its status
            if (line === null)
                return

            const search = this.#pending.shift()
            if (search) {
                this.#pendingSize -= search.size
                search.resolve(tryOrNull(() => JSON.parse(line)))
            }
            this.#readReply(process)
        })
    }

    #exitStatus(process) {
        if (process.get_if_exited())
            return ` with status ${process.get_exit_status()}`
        if (process.get_if_signaled())
            return ` after signal ${process.get_term_sig()}`
        return ''
    }

    /** @param {string} [reason] logged if given: the process stopped unexpectedly */
    #stop(reason) {
        if (reason)
            console.warn(`${this.#logPrefix}: ${reason}`)

        this.#cancellable?.cancel()
        tryOrNull(() => this.#stdin?.close(null))
        this.#process?.force_exit()

        this.#process = null
        this.#stdin = null
        this.#stdout = null
        this.#cancellable = null

        for (const {resolve} of this.#pending.splice(0))
            resolve(null)
        this.#pendingSize = 0
    }
}

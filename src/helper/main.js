#!@GJS@ -m

// Search helper of the extension. It isn't imported by the extension: it runs
// in a process of its own, started by SearchHelper in shadowSearch.js with
// `gjs -m`, and it exits when its stdin gets closed.
//
// It runs GLib's app search, the one stock GNOME Shell uses, for each query it
// reads on stdin (one per line), and writes each result on stdout as one line
// of JSON: the groups of desktop IDs returned by DesktopAppInfo.search().
//
// It's started with LANGUAGE=C, so that GLib uses the untranslated strings of
// the desktop files, and with XDG_DATA_HOME and XDG_DATA_DIRS set so that the
// only desktop files it sees are the copies kept by ShadowSync, in which those
// strings hold both languages. GLib monitors these files itself, so
// changes to them are picked up without a restart.

import Gio from 'gi://Gio'
import GioUnix from 'gi://GioUnix'

const stdin = new Gio.DataInputStream({base_stream: new GioUnix.InputStream({fd: 0})})

// Synchronous reads, without a main loop: nothing else runs in this process,
// and memory doesn't grow with each query, unlike with asynchronous reads
// (whose objects only get collected when the garbage collector runs, which it
// barely does in a process this idle).
for (;;) {
    const [query] = stdin.read_line_utf8(null)
    if (query === null)
        break

    let groups = []
    try {
        groups = GioUnix.DesktopAppInfo.search(query)
    } catch (e) {
        // The query is not directly logged to avoid getting what the user typed
        // end up in the journal.
        printerr(`A search failed: ${e}`)
    }
    print(JSON.stringify(groups))
}

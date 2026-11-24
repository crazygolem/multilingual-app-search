import Gio from 'gi://Gio'
import GLib from 'gi://GLib'


export function tryOrNull(fn) {
    try {
        return fn()
    } catch {
        return null
    }
}

/** Returns the names of the entries of a directory, or none if it doesn't exist. */
export function listDir(path) {
    const names = []
    try {
        const children = Gio.File.new_for_path(path)
            .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
        let info
        while ((info = children.next_file(null)) !== null)
            names.push(info.get_name())
        children.close(null)
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.error(e)
    }
    return names
}

/** Deletes a file, or a directory and everything in it. */
export function removeTree(path) {
    const file = Gio.File.new_for_path(path)
    try {
        const type = file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
        if (type === Gio.FileType.DIRECTORY) {
            for (const name of listDir(path))
                removeTree(GLib.build_filenamev([path, name]))
        }
        file.delete(null)
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.error(e)
    }
}

[private]
@default:
    just --list

# Package the extension, with everything in src/
pack:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p dist/

    # `gnome-extensions pack src/` only picks up a fixed set of files in src/,
    # anything else must be explicitly added via `--extra-source` arguments.
    # cf. pack_extension https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/51.1/subprojects/extensions-tool/src/command-pack.c#L376-381
    #
    # Extra sources are relative to src/, can be directories, and the files it
    # already includes (extension.js, metadata.json) are not added twice.
    extras=(--extra-source ../LICENSE)
    for path in src/*; do
        extras+=(--extra-source "${path#src/}")
    done
    gnome-extensions pack --force "${extras[@]}" --out-dir dist/ src/

# Package and run the extension in a nested shell
debug: pack
    gnome-extensions install --force dist/bilingual-app-search@pwa.lu.shell-extension.zip

    # The following command requires the `mutter-devkit` binary. If not present,
    # it might give an error, or no error but the nested shell will just not
    # appear.
    dbus-run-session -- gnome-shell --devkit

# Package and upload the extension to EGO
upload: pack
    # Ensure that all changes have been committed
    test -z "$(git status --porcelain src/)"
    gnome-extensions upload --accept-tos dist/bilingual-app-search@pwa.lu.shell-extension.zip

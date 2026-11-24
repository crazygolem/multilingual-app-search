set positional-arguments

[private]
@default:
    just --list

# Package the extension, with everything in src/
pack *args:
    #!/usr/bin/env bash
    set -euo pipefail

    release=1
    for arg in "$@"; do
        case "$arg" in
            --no-release) release=0 ;;
            *) >&2 echo "error: unknown argument: $arg"; exit 2 ;;
        esac
    done

    if (( release )); then
        # Both run, so that one run reports all the problems
        checks=0
        just check-po || checks=1
        just lint || checks=1
        if (( checks != 0 )); then
            >&2 echo "note: \`just pack --no-release\` packages the extension without the checks"
            exit 1
        fi
    fi

    mkdir -p dist/

    # `gnome-extensions pack src/` only picks up a fixed set of files in src/,
    # anything else must be explicitly added via `--extra-source` arguments.
    # cf. pack_extension https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/51.1/subprojects/extensions-tool/src/command-pack.c#L376-381
    #
    # Extra sources are relative to src/, can be directories, and the files it
    # already includes (extension.js, metadata.json, etc.) are not added twice.
    extras=(--extra-source ../LICENSE)
    for path in src/*; do
        extras+=(--extra-source "${path#src/}")
    done

    # The translations are compiled (with msgfmt, from gettext) into locale/.
    # They're kept out of src/, as the loop above would add their sources.
    # The path is relative to src/.
    gnome-extensions pack --force "${extras[@]}" --podir ../po --out-dir dist/ src/

# Update the translation template from the code, and the translations from it
update-po:
    #!/usr/bin/env bash
    set -euo pipefail
    shopt -s nullglob

    domain="$(jq -er '."gettext-domain"' src/metadata.json)"
    pot="po/${domain}.pot"
    just pot "$pot"

    # A new translation starts as a copy of the template, so its language
    # (which translation tools read) is set here, from its file's name
    for po in po/*.po; do
        msgmerge --quiet --update --backup=none --lang="$(basename "$po" .po)" "$po" "$pot"
    done

# Check that the translations have every string of the code, none fuzzy, no leftovers
check-po:
    #!/usr/bin/env bash
    set -euo pipefail
    shopt -s nullglob

    # The translations are compared with a template made from the code, so
    # that the check doesn't rely on `just update-po` having been run. Only
    # the strings are compared: where they are in the code doesn't matter.
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    just pot "$tmp/template.pot"

    status=0
    for po in po/*.po; do
        msgcmp "$po" "$tmp/template.pot" || status=1

        # Leftover entries, for strings the code doesn't have anymore: the
        # obsolete ones (#~) that msgmerge keeps, and those of a translation
        # that wasn't merged since, which become obsolete when merged here.
        # Without fuzzy matching, so that none passes for a new string.
        msgmerge --quiet --no-fuzzy-matching "$po" "$tmp/template.pot" --output-file="$tmp/merged.po"
        leftovers="$(msgattrib --only-obsolete "$tmp/merged.po" | sed '1,/^$/d')"
        if [[ -n $leftovers ]]; then
            >&2 echo "$po: entries for strings that aren't in the code anymore:"
            >&2 sed 's/^/    /' <<<"$leftovers"
            status=1
        fi
    done
    if (( status != 0 )); then
        >&2 echo "error: translations are missing, fuzzy or left over: run \`just update-po\`, then translate or review the strings above, and delete the obsolete ones (#~)"
    fi
    exit "$status"

# Write the translation template, made from the code, to `output`
[private]
pot output:
    #!/usr/bin/env bash
    set -euo pipefail
    output="$1"

    # xgettext's header is mostly placeholders, and msgmerge copies some of its
    # fields into each translation, e.g. the creation date, which would change
    # them all at every run. So it's replaced by the only field that is used:
    # the charset (UTF-8, from --from-code), without which msgfmt can't compile
    # the translations. The header can't just be omitted (--omit-header):
    # without its charset, xgettext mangles non-ASCII strings.
    mapfile -t sources < <(find src -name '*.js' | sort)
    {
        printf '%s\n' \
            'msgid ""' \
            'msgstr ""' \
            '"Content-Type: text/plain; charset=UTF-8\n"' \
            ''
        xgettext --from-code=UTF-8 --language=JavaScript \
            --add-comments=Translators: \
            --output=- \
            "${sources[@]}" \
        | sed '1,/^$/d'
    } >"$output.new"
    mv "$output.new" "$output"

# Check the code with ESLint (set up by `just devenv-setup`)
lint:
    #!/usr/bin/env bash
    set -euo pipefail

    if [[ ! -x node_modules/.bin/eslint ]]; then
        >&2 echo "error: ESLint is not installed: run \`just devenv-setup\` first"
        exit 1
    fi
    node_modules/.bin/eslint src/

# Package and run the extension in a nested shell
debug: (pack "--no-release")
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

# Set up code completion in editors, and ESLint
devenv-setup shell="latest":
    #!/usr/bin/env bash
    set -euo pipefail
    shell="$1"

    # Start over, so that nothing is left from another shell version. Writing
    # package.json keeps bun from using one in a parent directory.
    rm -rf node_modules/ bun.lock
    echo '{}' > package.json

    # Imports the appropriate version of @girs/gjs as a transitive dependency.
    # GNOME's ESLint config isn't published on npm, so it's pinned to a commit
    # of its repository, like GJS and GNOME Shell do (tools/package.json).
    #
    # ESLint 9 is no longer supported (bun warns that it's deprecated), but
    # it's the version GNOME's config is made for, and the one GJS and GNOME
    # Shell use. With ESLint 10, no-shadow flags the class names in the usual
    # GObject.registerClass(class Name ...), and the config's JSDoc plugin
    # (eslint-plugin-jsdoc 48) still pulls ESLint 9 in.
    bun add --no-save \
        "@girs/gnome-shell@${shell}" \
        'eslint@^9.39' \
        'git+https://gitlab.gnome.org/World/javascript/eslint-config-gnome.git#c479d059e8d9ea99c3b53c2ea43abf7fdb05eb51'

    # Declares the gi:// and resource:/// module paths
    cat > ambient.d.ts <<'EOF'
    import "@girs/gjs";
    import "@girs/gjs/dom";
    import "@girs/gnome-shell/ambient";
    import "@girs/gnome-shell/extensions/global";
    EOF

    # Sets up code completion in editors that use the TypeScript language server
    cat > jsconfig.json <<'EOF'
    {
      "compilerOptions": {
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "target": "ES2022",
        "lib": ["ES2022"],
        "checkJs": false,
        "skipLibCheck": true
      },
      "include": ["**/*.js", "ambient.d.ts"],
      "exclude": ["node_modules"]
    }
    EOF

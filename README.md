<p align="center">
  <img alt="" src="./resources/logo.svg" />
</p>
<p align="center">
  <a href="https://extensions.gnome.org/extension/7269/bilingual-app-search/">
    <img alt="Get it on GNOME Extensions" src="https://img.shields.io/gnome-extensions/dt/bilingual-app-search%40pwa.lu?style=for-the-badge&logo=gnome&logoColor=white&label=Get%20it%20on%20GNOME%20Extensions&labelColor=blue&color=gray">
  </a>
</p>

A GNOME extension to make GNOME Search look up applications in several languages.

This started out as a workaround for the GNOME issue [#443 (Search for applications in both English and local language)](https://gitlab.gnome.org/GNOME/glib/-/issues/443), and has since gained full multilingual search support with configurable languages.

**Is this extension for you?**

GNOME Search only looks for applications in your system's language.
You might find this extension useful if:
- you sometimes look for applications by their original name ("Files" instead of "Fichiers", "Bottles" instead of "Bouteilles");
- you use several languages, and know some applications by their name in a language other than your system's.

The original names, usually in English, are the ones applications use when they have no translation.
They help because GNOME application authors and/or packagers tend to give applications overly generic names that then get translated (e.g. "Files" instead of "Nautilus"), and to eagerly translate even specific names (e.g. "Bouteilles" as the French translation of "Bottles").

This especially helps with applications installed as Flatpak, as GNOME Search ignores their Desktop file's `Exec` line, which usually contains the original, specific application name ("nautilus", "bottles").

**When should this extension not be used?**

This extension is basically not compatible with any other extension that customizes GNOME Search's applications result list.
The reason for this is that this part of the dashboard is not extensible, and must therefore be monkey-patched; there is currently no framework for extensions to collaborate on this part.

If you're unhappy with other aspects of GNOME Search's algorithm this extension might not scratch your itch, as it attempts to match GNOME Search's algorithm as closely as possible, only taking into account extra languages.

## Install

### Install from extensions.gnome.org

Go to the [GNOME Extensions page for this extension](https://extensions.gnome.org/extension/7269/bilingual-app-search/) and click on the install button.

By default, the extension searches in your session's language, then the applications' default language (usually English).
In the extension's preferences, you can add other languages, remove the default language, and change their order (which can affect the ranking).
A regional variant also finds its language's strings: German (Austria) finds an application's German names.
An application that has none of your languages is still found by its default strings, as in stock search.

## How it works

GNOME Search finds applications with GLib's search function, which only looks at the strings in your language.
This extension makes it search a shadow copy of your applications' Desktop files instead, in which each value holds the application's strings in all languages selected in the extension's preferences.
The search runs in a small helper process (a GJS script), which calls GLib's standard search function on the shadow copies.

Searching all the languages at once, rather than each one separately, lets GLib rank all matches together: combining separate searches would always list the matches in one language before those in another, even when the latter match better.
However, since GLib 2.86 (GNOME 49), matches in earlier words rank higher, and in the shadow copies, the words of each language come after those of the languages before it in the preferences' order.
A match in a later language therefore usually ranks below an otherwise equal match in an earlier one.

The Settings section of the search results also lists the Settings panels that match in the other languages ("Privacy" instead of "Vie privée").
Settings only finds its panels in your language, so the extension adds the panels that GLib's search finds in the shadow copies, after the ones Settings found, when they match only thanks to the other languages.
Those are matched with GLib's rules, which only look at the panels' names and keywords: unlike Settings, they don't look at the descriptions.

Earlier versions of the extension reimplemented GLib's search instead, which could merge the results better across languages, but had to be kept in sync with every upstream change.

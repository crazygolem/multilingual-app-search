// GNOME's recommended ESLint config, with the project's style. Installed by
// `just devenv-setup`, run by `just lint`.

import {defineConfig} from 'eslint/config'
import gnome from 'eslint-config-gnome'


export default defineConfig([
    gnome.configs.recommended,
    {
        languageOptions: {
            sourceType: 'module',
        },
        rules: {
            'semi': ['error', 'never'],
            // Prose is in double quotes, so that it can gain an apostrophe,
            // and the other strings in single quotes, which ESLint can't tell
            // apart
            'quotes': 'off',
        },
    },
    {
        // InjectionManager's overrides get the patched object as `this`
        files: ['src/shell/*ProviderPatch.js'],
        rules: {
            'no-invalid-this': 'off',
        },
    },
])

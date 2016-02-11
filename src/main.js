/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Perf measurements
global.vscodeStart = Date.now();

var app = require('electron').app;
var fs = require('fs');
var path = require('path');

// Duplicated in ../index.html for the renderes.
function getNLSConfiguration() {
	var locale = undefined;
	var localeOpts = '--locale';
	for (var i = 0; i < process.argv.length; i++) {
		var arg = process.argv[i];
		if (arg.slice(0, localeOpts.length) == localeOpts) {
			var segments = arg.split('=');
			locale = segments[1];
			break;
		}
	}

	if (locale === 'pseudo') {
		return { availableLanguages: {}, pseudo: true }
	}
	if (process.env.VSCODE_DEV) {
		return { availableLanguages: {} };
	}
	// We have a built version so we have extracted nls file. Try to find
	// the right file to use.
	locale = locale || app.getLocale();
	while (locale) {
		var candidate = path.join(__dirname, 'main.nls.') + locale + '.js';
		if (fs.existsSync(candidate)) {
			return { availableLanguages: { '*': locale } };
		} else {
			var index = locale.lastIndexOf('-');
			if (index > 0) {
				locale = locale.substring(0, index);
			} else {
				locale = null;
			}
		}
	}

	return { availableLanguages: {} };
}

// Change cwd if given via env variable
try {
	if (process.env.VSCODE_CWD) {
		process.chdir(process.env.VSCODE_CWD);
	}
} catch (err) {
	// noop
}

// Set path according to being built or not
if (process.env.VSCODE_DEV) {
	var appData = app.getPath('appData');
	app.setPath('userData', path.join(appData, 'Code-Development'));
}

// Mac: when someone drops a file to the not-yet running VSCode, the open-file event fires even before
// the app-ready event. We listen very early for open-file and remember this upon startup as path to open.
global.macOpenFiles = [];
app.on('open-file', function(event, path) {
	global.macOpenFiles.push(path);
});

var nlsConfig = getNLSConfiguration();
process.env['VSCODE_NLS_CONFIG'] = JSON.stringify(nlsConfig);

// Load our code once ready
app.once('ready', function() {
	process.env['AMD_ENTRYPOINT'] = 'vs/workbench/electron-main/main';
	require('./bootstrap-amd');
});

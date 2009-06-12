/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Michael Kraft.
 *
 * The Initial Developer of the Original Code is Mozilla.
 * Portions created by the Initial Developer are Copyright (C) 2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */
const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const report = Components.utils.reportError;

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

function SessionManagerHelperComponent() {}

SessionManagerHelperComponent.prototype = {
	// registration details
	classDescription: "Session Manager Helper Component",
	classID:          Components.ID("{5714d620-47ce-11db-b0de-0800200c9a66}"),
	contractID:       "@morac/sessionmanager-helper;1",
	_xpcom_categories: [{ category: "app-startup", service: true }],
	mBackupState: null,
	mSessionData: null,
	
	// interfaces supported
	QueryInterface: XPCOMUtils.generateQI([Ci.nsISessionManangerHelperComponent, Ci.nsIObserver]),

	// observer
	observe: function(aSubject, aTopic, aData)
	{
		let os = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
		
		switch (aTopic)
		{
		case "app-startup":
			os.addObserver(this, "private-browsing-change-granted", false);
			os.addObserver(this, "profile-after-change", false);
			os.addObserver(this, "final-ui-startup", false);
			os.addObserver(this, "sessionstore-state-read", false);
			break;
		case "private-browsing-change-granted":
			switch(aData) {
			case "enter":
				let ss = Cc["@mozilla.org/browser/sessionstore;1"] || Cc["@mozilla.org/suite/sessionstore;1"];
				this.mBackupState = ss.getService(Ci.nsISessionStore).getBrowserState();
				break;
			case "exit":
				aSubject.QueryInterface(Ci.nsISupportsPRBool);
				// If browser not shutting down, clear the backup state otherwise leave it to be read by sessionmanager.js
				if (!aSubject.data) {
					this.mBackupState = null;
				}
				break;
			}
			break;
		case "profile-after-change":
			os.removeObserver(this, aTopic);
			try
			{
				this._restoreCache();
			}
			catch (ex) { report(ex); }
			break;
		case "final-ui-startup":
			os.removeObserver(this, aTopic);
			try
			{
				this._handle_crash();
			}
			catch (ex) { dump(ex); }
			
			// stuff to handle preference file saving
			this.mTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
			os.addObserver(this, "quit-application-granted", false);
			os.addObserver(this, "sessionmanager-preference-save", false);
			break;
		case "sessionstore-state-read":
			os.removeObserver(this, aTopic);
			try 
			{
				this._check_for_crash(aSubject);
			}
			catch (ex) { report(ex); }
			break;
		case "sessionmanager-preference-save":
			// Save preference file after one 1/4 second to delay in case another preference changes at same time as first
			this.mTimer.cancel();
			this.mTimer.initWithCallback({
				notify:function (aTimer) { Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefService).savePrefFile(null); }
			}, 250, Ci.nsITimer.TYPE_ONE_SHOT);
			break;
		case "quit-application-granted":
			os.removeObserver(this, "sessionmanager-preference-save");
			os.removeObserver(this, aTopic);
			break;
		}
	},

	/* ........ public methods ............... */

	// this will save the passed in session data into the mSessionData variable
	setSessionData: function(aState) 
	{
		this.mSessionData = aState;
	},

	/* ........ private methods .............. */

	// this will handle the case where user turned off crash recovery and browser crashed and
	// preference indicates there is an active session, but there really isn't
	_handle_crash: function()
	{
		let prefroot = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
		let sessionStartup = Cc["@mozilla.org/browser/sessionstartup;1"] || Cc["@mozilla.org/suite/sessionstartup;1"];
		if (sessionStartup) sessionStartup = sessionStartup.getService(Ci.nsISessionStartup);
		let resuming = (sessionStartup && sessionStartup.sessionType && (sessionStartup.sessionType != Ci.nsISessionStartup.NO_SESSION)) ||
		               prefroot.getBoolPref("browser.sessionstore.resume_session_once") || 
		               prefroot.getBoolPref("browser.sessionstore.resume_from_crash");

		let sm_running = (prefroot.getPrefType("extensions.sessionmanager._running") == prefroot.PREF_BOOL) && 
		                 prefroot.getBoolPref("extensions.sessionmanager._running");
		
		//dump("running = " + sm_running + "\nresuming = " + resuming + "\n");
		//report("running = " + sm_running + "\nresuming = " + resuming + "\n");
		if (sm_running && !resuming)
		{
			dump("SessionManager: Removing active session\n");
			prefroot.deleteBranch("extensions.sessionmanager._autosave_values");
			prefroot.deleteBranch("extensions.sessionmanager._running");
			prefroot.deleteBranch("extensions.sessionmanager._recovering");
			prefroot.deleteBranch("extensions.sessionmanager._encrypt_file");
		}
	},
	
	// This will check to see if there was a crash and if so put up the crash prompt 
	// to allow the user to choose a session to restore.  This is only called for Firefox 3.5 and up and SeaMonkey 2.0 and up
	_check_for_crash: function(aStateDataString)
	{
		let initialState;
		try {
			// parse the session state into JS objects
			initialState = this.JSON_decode(aStateDataString.QueryInterface(Ci.nsISupportsString).data);
		}
		catch (ex) { 
			report("The startup session file is invalid: " + ex); 
			return;
		} 
    
		let lastSessionCrashed =
			initialState && initialState.session && initialState.session.state &&
			initialState.session.state == "running";
		
		//report("Last Crashed = " + lastSessionCrashed);
		if (lastSessionCrashed) {
        	let params = Cc["@mozilla.org/embedcomp/dialogparam;1"].createInstance(Ci.nsIDialogParamBlock);
        	// default to recovering
        	params.SetInt(0, 0);
        	Cc["@mozilla.org/embedcomp/window-watcher;1"].getService(Ci.nsIWindowWatcher).
        		openWindow(null, "chrome://sessionmanager/content/restore_prompt.xul", "_blank", "chrome,modal,centerscreen,titlebar", params);
        	if (params.GetInt(0) == 1) aStateDataString.QueryInterface(Ci.nsISupportsString).data = "";
        	else if (initialState.session) {
	        	// don't prompt for tabs if checkbox not checked
	        	delete(initialState.session.lastUpdate);
	        	delete(initialState.session.recentCrashes);
	        	aStateDataString.QueryInterface(Ci.nsISupportsString).data = this.JSON_encode(initialState);
        	}
    	}
    	initialState = null;
	},

	// code adapted from Danil Ivanov's "Cache Fixer" extension
	_restoreCache: function()
	{
    	let cache = null;
		try 
		{
			let prefroot = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
			let disabled = prefroot.getBoolPref("extensions.sessionmanager.disable_cache_fixer");
			if (disabled)
			{
				let consoleService = Cc["@mozilla.org/consoleservice;1"].getService(Ci.nsIConsoleService);
  				consoleService.logStringMessage("SessionManager: Cache Fixer disabled");
				return;
			}
			let pd_path = prefroot.getComplexValue("browser.cache.disk.parent_directory",Ci.nsISupportsString).data;
			cache = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
			cache.initWithPath(pd_path);
		}
		catch (ex) {}
		
		if (!cache) cache = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfLD", Ci.nsILocalFile);
		cache.append("Cache");
		cache.append("_CACHE_MAP_");
		if (!cache.exists())
		{
			return;
		}
		
		let stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
		stream.init(cache, 0x01, 0, 0); // PR_RDONLY
		let input = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
		input.setInputStream(stream);
		let content = input.readByteArray(input.available());
		input.close();
		
		if (content[15] != 1)
		{
			return;
		}
		content[15] = 0;
		
		stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
		stream.init(cache, 0x02 | 0x20, 0600, 0); // PR_WRONLY | PR_TRUNCATE
		let output = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream);
		output.setOutputStream(stream);
		output.writeByteArray(content, content.length);
		output.flush();
		output.close();
	},
	
	// Decode JSON string to javascript object
	JSON_decode: function(aStr) {
		let jsObject = { windows: [{ tabs: [{ entries:[] }], selected:1, _closedTabs:[] }], _JSON_decode_failed:true };
		try {
			let hasParens = ((aStr[0] == '(') && aStr[aStr.length-1] == ')');
		
			// JSON can't parse when string is wrapped in parenthesis
			if (hasParens) {
				aStr = aStr.substring(1, aStr.length - 1);
			}
		
			// Session Manager 0.6.3.5 and older had been saving non-JSON compiant data so try to use evalInSandbox if JSON parse fails
			try {
				jsObject = JSON.parse(aStr);
			}
			catch (ex) {
				if (/[\u2028\u2029]/.test(aStr)) {
					aStr = aStr.replace(/[\u2028\u2029]/g, function($0) {"\\u" + $0.charCodeAt(0).toString(16)});
				}
				jsObject = Cu.evalInSandbox("(" + aStr + ")", new Cu.Sandbox("about:blank"));
			}
		}
		catch(ex) {
			report("SessionManager: " + ex);
		}
		return jsObject;
	},
	
	// Encode javascript object to JSON string - use JSON if built-in.
	JSON_encode: function(aObj) {
		let jsString = null;
		try {
			jsString = JSON.stringify(aObj);
			// Workaround for Firefox bug 485563
			if (/[\u2028\u2029]/.test(jsString)) {
				jsString = jsString.replace(/[\u2028\u2029]/g, function($0) {"\\u" + $0.charCodeAt(0).toString(16)});
			}
		}
		catch(ex) {
			report("SessionManager: " + ex);
		}
		return jsString;
	},
};

// Register Component
function NSGetModule(compMgr, fileSpec) {
  return XPCOMUtils.generateModule([SessionManagerHelperComponent]);
}
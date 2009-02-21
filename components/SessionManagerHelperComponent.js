const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;
const FIREFOX = "{ec8030f7-c20a-464f-9b0e-13a3a9e97384}";
const SEAMONKEY= "{92650c4d-4b8e-4d2a-b7eb-24ecf4f6b63a}";
const report = Components.utils.reportError;

var SessionManagerHelperComponent = {
	mCID: Components.ID("{5714d620-47ce-11db-b0de-0800200c9a66}"),
	mContractID: "@morac/sessionmanager-helper;1",
	mClassName: "Session Manager Helper Component",
	mCategory: "a-sessionmanagerhelpher",
	mTimer: null,
	mPrefService: null,
	mSessionData: null,

/* ........ nsIModule .............. */

	getClassObject: function(aCompMgr, aCID, aIID)
	{
		if (!aCID.equals(this.mCID))
		{
			Components.returnCode = Cr.NS_ERROR_NOT_REGISTERED;
			return null;
		}
		
		return this.QueryInterface(aIID);
	},

	registerSelf: function(aCompMgr, aFileSpec, aLocation, aType)
	{
		aCompMgr.QueryInterface(Ci.nsIComponentRegistrar);
		aCompMgr.registerFactoryLocation(this.mCID, this.mCategory, this.mContractID, aFileSpec, aLocation, aType);
		
		var catMan = Cc["@mozilla.org/categorymanager;1"].getService(Ci.nsICategoryManager);
		catMan.addCategoryEntry("app-startup", this.mClassName, "service," + this.mContractID, true, true);
	},

	unregisterSelf: function(aCompMgr, aLocation, aType)
	{
		aCompMgr.QueryInterface(Ci.nsIComponentRegistrar);
		aCompMgr.unregisterFactoryLocation(this.mCID, aLocation);
		
		var catMan = Cc["@mozilla.org/categorymanager;1"].getService(Ci.nsICategoryManager);
		catMan.deleteCategoryEntry("app-startup", "service," + this.mContractID, true);
	},

	canUnload: function(aCompMgr)
	{
		return true;
	},

/* ........ nsIFactory .............. */

	createInstance: function(aOuter, aIID)
	{
		if (aOuter != null)
		{
			Components.returnCode = Cr.NS_ERROR_NO_AGGREGATION;
			return null;
		}
		
		return this.QueryInterface(aIID);
	},

	lockFactory: function(aLock) { },

/* ........ nsIObserver .............. */

	observe: function(aSubject, aTopic, aData)
	{
		var os = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
		
		switch (aTopic)
		{
		case "app-startup":
			os.addObserver(this, "profile-after-change", false);
			os.addObserver(this, "final-ui-startup", false);
			os.addObserver(this, "sessionstore-state-read", false);
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
			this.mPrefService = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefService);
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
			this.mTimer.initWithCallback({notify:function (aTimer) {SessionManagerHelperComponent.mPrefService.savePrefFile(null);}}, 250, Ci.nsITimer.TYPE_ONE_SHOT);
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
		var prefroot = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
		var sessionStartup = Cc["@mozilla.org/browser/sessionstartup;1"];
		if (!sessionStartup) sessionStartup = Cc["@mozilla.org/suite/sessionstartup;1"];
		if (sessionStartup) sessionStartup = sessionStartup.getService(Ci.nsISessionStartup);
		var resuming = (sessionStartup && sessionStartup.sessionType && (sessionStartup.sessionType != Ci.nsISessionStartup.NO_SESSION)) ||
		               prefroot.getBoolPref("browser.sessionstore.resume_session_once") || 
		               prefroot.getBoolPref("browser.sessionstore.resume_from_crash");

		var sm_running = (prefroot.getPrefType("extensions.sessionmanager._running") == prefroot.PREF_BOOL) && 
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
	// to allow the user to choose a session to restore
	_check_for_crash: function(aStateDataString)
	{
		try {
			// parse the session state into JS objects
			var initialState = this.JSON_decode(aStateDataString.QueryInterface(Ci.nsISupportsString).data);
		}
		catch (ex) { 
			report("The startup session file is invalid: " + ex); 
			return;
		} 
    
		var lastSessionCrashed =
			initialState && initialState.session && initialState.session.state &&
			initialState.session.state == "running";
		
		//report("Last Crashed = " + lastSessionCrashed);
		if (lastSessionCrashed) {
        	var params = Cc["@mozilla.org/embedcomp/dialogparam;1"].createInstance(Ci.nsIDialogParamBlock);
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
    	var cache = null;
		try 
		{
			var prefroot = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
			var disabled = prefroot.getBoolPref("extensions.sessionmanager.disable_cache_fixer");
			if (disabled)
			{
				var consoleService = Cc["@mozilla.org/consoleservice;1"].getService(Ci.nsIConsoleService);
  				consoleService.logStringMessage("SessionManager: Cache Fixer disabled");
				return;
			}
			var pd_path = prefroot.getComplexValue("browser.cache.disk.parent_directory",Ci.nsISupportsString).data;
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
		
		var stream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
		stream.init(cache, 0x01, 0, 0); // PR_RDONLY
		var input = Cc["@mozilla.org/binaryinputstream;1"].createInstance(Ci.nsIBinaryInputStream);
		input.setInputStream(stream);
		var content = input.readByteArray(input.available());
		input.close();
		
		if (content[15] != 1)
		{
			return;
		}
		content[15] = 0;
		
		stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
		stream.init(cache, 0x02 | 0x20, 0600, 0); // PR_WRONLY | PR_TRUNCATE
		var output = Cc["@mozilla.org/binaryoutputstream;1"].createInstance(Ci.nsIBinaryOutputStream);
		output.setOutputStream(stream);
		output.writeByteArray(content, content.length);
		output.flush();
		output.close();
	},
	
	/**
	* Converts a JavaScript object into a JSON string
	* (see http://www.json.org/ for the full grammar).  Only used in Firefox 2.0
	*
	* The inverse operation consists of eval("(" + JSON_string + ")");
	* and should be provably safe.
	*
	* @param aJSObject is the object to be converted
	* @return the object's JSON representation
	*/
	toJSONString: function toJSONString(aJSObject) {
		// these characters have a special escape notation
		const charMap = { "\b": "\\b", "\t": "\\t", "\n": "\\n", "\f": "\\f",
		                  "\r": "\\r", '"': '\\"', "\\": "\\\\" };
		// we use a single string builder for efficiency reasons
		var parts = [];
		
		// this recursive function walks through all objects and appends their
		// JSON representation to the string builder
		function jsonIfy(aObj) {
			if (typeof aObj == "boolean") {
				parts.push(aObj ? "true" : "false");
			}
			else if (typeof aObj == "number" && isFinite(aObj)) {
				// there is no representation for infinite numbers or for NaN!
				parts.push(aObj.toString());
			}
			else if (typeof aObj == "string") {
				aObj = aObj.replace(/[\\"\x00-\x1F\u0080-\uFFFF]/g, function($0) {
				// use the special escape notation if one exists, otherwise
				// produce a general unicode escape sequence
				return charMap[$0] ||
					"\\u" + ("0000" + $0.charCodeAt(0).toString(16)).slice(-4);
				});
				parts.push('"' + aObj + '"')
			}
			else if (aObj == null) {
				parts.push("null");
			}
			// if it looks like an array, treat it as such -
			// this is required for all arrays from a sandbox
			else if (aObj instanceof Array ||
					typeof aObj == "object" && "length" in aObj &&
					(aObj.length === 0 || aObj[aObj.length - 1] !== undefined)) {
				parts.push("[");
				for (var i = 0; i < aObj.length; i++) {
					jsonIfy(aObj[i]);
					parts.push(",");
				}
				if (parts[parts.length - 1] == ",")
					parts.pop(); // drop the trailing colon
				parts.push("]");
			}
			else if (typeof aObj == "object") {
				parts.push("{");
				for (var key in aObj) {
					if (key == "_tab")
						continue; // XXXzeniko we might even want to drop all private members
			
					jsonIfy(key.toString());
					parts.push(":");
					jsonIfy(aObj[key]);
					parts.push(",");
				}
				if (parts[parts.length - 1] == ",")
					parts.pop(); // drop the trailing colon
				parts.push("}");
			}
			else {
				throw new Error("No JSON representation for this object!");
			}
		}
		jsonIfy(aJSObject);
		
		var newJSONString = parts.join(" ");
		// sanity check - so that API consumers can just eval this string
		if (/[^,:{}\[\]0-9.\-+Eaeflnr-u \n\r\t]/.test(
			newJSONString.replace(/"(\\.|[^"\\])*"/g, "")
		))
		throw new Error("JSON conversion failed unexpectedly!");
		
		return newJSONString;
	},
	
	// Decode JSON string to javascript object - use JSON if built-in.
	JSON_decode: function(aStr) {
		var jsObject = { windows: [{ tabs: [{ entries:[] }], selected:1, _closedTabs:[] }] };
		try {
			var hasParens = ((aStr[0] == '(') && aStr[aStr.length-1] == ')');
			var builtInJSON = typeof(JSON) != "undefined";
		
			// JSON can't parse when string is wrapped in parenthesis
			if (builtInJSON && hasParens) {
				aStr = aStr.substring(1, aStr.length - 1);
			}
		
			if (builtInJSON) {
				// Session Manager 0.6.3.5 and older had been saving non-JSON compiant data so try to use evalInSandbox if JSON parse fails
				try {
					jsObject = JSON.parse(aStr);
				}
				catch (ex) {
					jsObject = Cu.evalInSandbox("(" + aStr + ")", new Cu.Sandbox("about:blank"));
				}
			}
			else {
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
		var jsString = null;
		try {
			if (typeof(JSON) != "undefined") {
				jsString = JSON.stringify(aObj);
			}
			else if (Cc["@mozilla.org/dom/json;1"]) {
				var nativeJSON = Cc["@mozilla.org/dom/json;1"].createInstance(Ci.nsIJSON);
				jsString = nativeJSON.encode(aObj);
			}
			else {
				jsString = this.toJSONString(aObj);
			}
		}
		catch(ex) {
			report("SessionManager: " + ex);
		}
		// If not SeaMonkey add parenthesis because Firefox needs them, but SeaMonkey won't work with them.  See Firefox bug 479627
		if (Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULAppInfo).ID != SEAMONKEY) {
			jsString = "(" + jsString + ")";
		}
		return jsString;
	},

/* ........ QueryInterface .............. */

	QueryInterface: function(aIID)
	{
		if (!aIID.equals(Ci.nsISupports) && !aIID.equals(Ci.nsIModule) && !aIID.equals(Ci.nsIFactory) && 
		    !aIID.equals(Ci.nsIObserver) && !aIID.equals(Ci.nsISessionManangerHelperComponent))
		{
			Components.returnCode = Cr.NS_ERROR_NO_INTERFACE;
			return null;
		}
		
		return this;
	}
};

function NSGetModule(aComMgr, aFileSpec)
{
	return SessionManagerHelperComponent;
}

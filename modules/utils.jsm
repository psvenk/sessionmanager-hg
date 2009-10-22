const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

Cu.import("resource://sessionmanager/modules/logger.js");

var EXPORTED_SYMBOLS = ["ioError", "sessionError", "makeFileName", "getProfileFile", "getSessionDir", "JSON_decode", "JSON_encode", "getSessions",
                        "SESSION_REGEXP", "AUTO_SAVE_SESSION_NAME", "SESSION_EXT", "cache"];

var JSON = Cc["@mozilla.org/dom/json;1"].createInstance(Ci.nsIJSON);
var Application = null;

// Constants
const SESSION_EXT = ".session";
const BACKUP_SESSION_REGEXP = /^backup(-[1-9](\d)*)?\.session$/;
const AUTO_SAVE_SESSION_NAME = "autosave.session";
const SESSION_REGEXP = /^\[SessionManager v2\]\nname=(.*)\ntimestamp=(\d+)\nautosave=(false|session\/?\d*|window\/?\d*)\tcount=([1-9][0-9]*)\/([1-9][0-9]*)(\tgroup=([^\t|^\n|^\r]+))?(\tscreensize=(\d+)x(\d+))?/m;
const SM_SESSIONS_DIR_PREFERENCE = "extensions.sessionmanager.sessions_dir";

//
// Exported Variables
//

var cache = {
	session: [],
	closedWindow: { timestamp: 0, data: null },
	
	setClosedWindowCache: function(aData, aTimestamp) {
		this.closedWindow.data = aData;
		this.closedWindow.timestamp = (aData ? aTimestamp : 0);
	},
};

//
// Exported Functions
//

// Put up IO error message
function ioError(aException)
{
	error(aException, "io_error");
}

// Put up session error message
function sessionError(aException)
{
	error(aException, "session_error");
}

// Make filename based on session name
function makeFileName(aString)
{
	return aString.replace(/[^\w ',;!()@&*+=~\x80-\xFE-]/g, "_").substr(0, 64) + SESSION_EXT;
}
	
// Get the profile dir
function getProfileFile(aFileName)
{
	let file = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfD", Ci.nsILocalFile).clone();
	file.append(aFileName);
	return file;
}

// Get the sessions dir
function getSessionDir(aFileName, aUnique)
{
	// Check for absolute path first, session names can't have \ or / in them so this will work.  Relative paths will throw though.
	if (/[\\\/]/.test(aFileName)) {
		let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
		try {
			file.initWithPath(aFileName);
		}
		catch(ex) {
			ioError(ex);
			file = null;
		}
		return file;
	}
	else {
		// allow overriding of location of sessions directory
		let dir = UserDirectory.getUserDir("sessions");

		// use default is not specified or not a writable directory
		if (dir == null) {
			dir = getProfileFile("sessions");
		}
		if (!dir.exists())
		{
			try {
				dir.create(Ci.nsIFile.DIRECTORY_TYPE, 0700);
			}
			catch (ex) {
				ioError(ex);
				return null;
			}
		}
		if (aFileName)
		{
			dir.append(aFileName);
			if (aUnique)
			{
				let postfix = 1, ext = "";
				if (aFileName.slice(-SESSION_EXT.length) == SESSION_EXT)
				{
					aFileName = aFileName.slice(0, -SESSION_EXT.length);
					ext = SESSION_EXT;
				}
				while (dir.exists())
				{
					dir = dir.parent;
					dir.append(aFileName + "-" + (++postfix) + ext);
				}
			}
		}
		return dir.QueryInterface(Ci.nsILocalFile);
	}
}

// Decode JSON string to javascript object - use JSON if built-in.
function JSON_decode(aStr, noError) {
	let jsObject = { windows: [{ tabs: [{ entries:[] }], selected:1, _closedTabs:[] }], _JSON_decode_failed:true };
	try {
		let hasParens = ((aStr[0] == '(') && aStr[aStr.length-1] == ')');
		
		// JSON can't parse when string is wrapped in parenthesis
		if (hasParens) {
			aStr = aStr.substring(1, aStr.length - 1);
		}
		
		// Session Manager 0.6.3.5 and older had been saving non-JSON compiant data so try to use evalInSandbox if JSON parse fails
		try {
			jsObject = JSON.decode(aStr);
		}
		catch (ex) {
			if (/[\u2028\u2029]/.test(aStr)) {
				aStr = aStr.replace(/[\u2028\u2029]/g, function($0) {"\\u" + $0.charCodeAt(0).toString(16)});
			}
			jsObject = Cu.evalInSandbox("(" + aStr + ")", new Cu.Sandbox("about:blank"));
		}
	}
	catch(ex) {
		jsObject._JSON_decode_error = ex;
		if (!noError) sessionError(ex);
	}
	return jsObject;
}
	
// Encode javascript object to JSON string - use JSON if built-in.
function JSON_encode(aObj) {
	let jsString = null;
	try {
		jsString = JSON.encode(aObj);
		// Needed until Firefox bug 387859 is fixed or else Firefox won't except JSON strings with \u2028 or \u2029 characters
		if (/[\u2028\u2029]/.test(jsString)) {
			jsString = jsString.replace(/[\u2028\u2029]/g, function($0) {"\\u" + $0.charCodeAt(0).toString(16)});
		}
	}
	catch(ex) {
		sessionError(ex);
	}
	return jsString;
}	


//
// filter - optional regular expression. If specified, will only return sessions that match that expression
//
function getSessions(filter)
{
	let matchArray;
	let sessions = [];
	sessions.latestTime = sessions.latestBackUpTime = 0;
	
	let filesEnum = getSessionDir().directoryEntries.QueryInterface(Ci.nsISimpleEnumerator);
	while (filesEnum.hasMoreElements())
	{
		let file = filesEnum.getNext().QueryInterface(Ci.nsIFile);
		// don't try to read a directory
		if (file.isDirectory()) continue;
		let fileName = file.leafName;
		let backupItem = (BACKUP_SESSION_REGEXP.test(fileName) || (fileName == AUTO_SAVE_SESSION_NAME));
		let cached = cache.session[fileName] || null;
		if (cached && cached.time == file.lastModifiedTime)
		{
			try {
				if (filter && !filter.test(cached.name)) continue;
			} catch(ex) { 
				log ("getSessions: Bad Regular Expression passed to getSessions, ignoring", true); 
			}
			if (!backupItem && (sessions.latestTime < cached.timestamp)) 
			{
				sessions.latestTime = cached.timestamp;
			}
			else if (backupItem && (sessions.latestBackUpTime < cached.timestamp)) {
				sessions.latestBackUpTime = cached.timestamp;
			}
			sessions.push({ fileName: fileName, name: cached.name, timestamp: cached.timestamp, autosave: cached.autosave, windows: cached.windows, tabs: cached.tabs, backup: backupItem, group: cached.group });
			continue;
		}
		if (matchArray = SESSION_REGEXP.exec(this.readSessionFile(file, true)))
		{
			try {
				if (filter && !filter.test(matchArray[1])) continue;
			} catch(ex) { 
				log ("getSessions: Bad Regular Expression passed to getSessions, ignoring", true); 
			}
			let timestamp = parseInt(matchArray[2]) || file.lastModifiedTime;
			if (!backupItem && (sessions.latestTime < timestamp)) 
			{
				sessions.latestTime = timestamp;
			}
			else if (backupItem && (sessions.latestBackUpTime < timestamp)) {
				sessions.latestBackUpTime = timestamp;
			}
			let group = matchArray[7] ? matchArray[7] : "";
			sessions.push({ fileName: fileName, name: matchArray[1], timestamp: timestamp, autosave: matchArray[3], windows: matchArray[4], tabs: matchArray[5], backup: backupItem, group: group });
			cache.session[fileName] = { name: matchArray[1], timestamp: timestamp, autosave: matchArray[3], time: file.lastModifiedTime, windows: matchArray[4], tabs: matchArray[5], backup: backupItem, group: group };
		}
	}

	let session_list_order = Application.prefs.get("extensions.sessionmanager.session_list_order");
	session_list_order = session_list_order ? session_list_order.value : 1;
	switch (Math.abs(session_list_order))
	{
	case 1: // alphabetically
		sessions = sessions.sort(function(a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
		break;
	case 2: // chronologically
		sessions = sessions.sort(function(a, b) { return a.timestamp - b.timestamp; });
		break;
	}

	return (session_list_order < 0)?sessions.reverse():sessions;
}


//
// Private Functions and Objects
//

// Object to save user session directory on browser shut down
var UserDirectory = {
	_initialized: false,
	_userDirectory: null,

	init: function() {
		let os = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
		os.addObserver(this, "quit-application-granted", false);
		this._initialized = true;
	},
	
	observe: function(aSubject, aTopic, aData) {
		switch (aTopic)
		{
		case "quit-application-granted":
			this._userDirectory = this.getUserDir("sessions");
			break;
		}
	},
	
	// Get the user specific sessions directory
	getUserDir: function(aFileName)
	{
		let dir = null;
		let dirname = null;

		try {
			let pb = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
			dirname = pb.getComplexValue(SM_SESSIONS_DIR_PREFERENCE,Ci.nsISupportsString).data;
			if (dirname) {
				let dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsILocalFile);
				dir.initWithPath(dirname);
				if (dir.isDirectory && dir.isWritable()) {
					dir.append(aFileName);
				}
				else {
					dir = null;
				}
			}
		} catch (ex) {
			// handle the case on shutdown since the above will always throw an exception on shutdown
			if (this._userDirectory) dir = this._userDirectory.clone();
			else dir = null;
		} finally {
			return dir;
		}
	}
}

// Put up error prompt
function error(aException, aString) {
	if (aException) logError(aException);
	
	let bundle = Cc["@mozilla.org/intl/stringbundle;1"].getService(Ci.nsIStringBundleService).createBundle("chrome://sessionmanager/locale/sessionmanager.properties");
	Cc["@mozilla.org/embedcomp/prompt-service;1"].getService(Ci.nsIPromptService).
		alert((typeof(window)=="object")?window:null, bundle.GetStringFromName("sessionManager"), bundle.formatStringFromName(aString, [(aException)?(aException.message + "\n\n" + aException.location):bundle.GetStringFromName("unknown_error")], 1));
}


// Get FUEL (SMILE in SeaMonkey) library
if (Cc["@mozilla.org/fuel/application;1"]) {
	Application = Cc["@mozilla.org/fuel/application;1"].getService(Ci.fuelIApplication);
} else if (Components.classes["@mozilla.org/smile/application;1"]) {
	Application = Cc["@mozilla.org/smile/application;1"].getService(Ci.smileIApplication);
}
UserDirectory.init();

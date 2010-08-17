// Configuration Constant Settings - addon specific
const ADDON_NAME = "Session Manager";
const FILE_NAME = "sessionmanager_log.txt";
const LOG_ENABLE_PREFERENCE_NAME = "extensions.{1280606b-2510-4fe0-97ef-9b5a22eafe30}.logging";
const LOG_LEVEL_PREFERENCE_NAME = "extensions.{1280606b-2510-4fe0-97ef-9b5a22eafe30}.logging_level";
const BUNDLE_URI = "chrome://sessionmanager/locale/sessionmanager.properties";
const ERROR_STRING_NAME = "file_not_found";
const UUID = "{1280606b-2510-4fe0-97ef-9b5a22eafe30}";

const Cc = Components.classes;
const Ci = Components.interfaces
const Cu = Components.utils;
const report = Components.utils.reportError;

// Get lazy getter functions from XPCOMUtils or define them if they don't exist (only defined in Firefox 3.6 and up)
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
if (typeof XPCOMUtils.defineLazyGetter == "undefined") {
	XPCOMUtils.defineLazyGetter = function XPCU_defineLazyGetter(aObject, aName, aLambda)
	{
		aObject.__defineGetter__(aName, function() {
			delete aObject[aName];
			return aObject[aName] = aLambda.apply(aObject);
		});
	}
}
if (typeof XPCOMUtils.defineLazyServiceGetter == "undefined") {
	XPCOMUtils.defineLazyServiceGetter = function XPCU_defineLazyServiceGetter(aObject, aName, aContract, aInterfaceName)
	{
		this.defineLazyGetter(aObject, aName, function XPCU_serviceLambda() {
			return Cc[aContract].getService(Ci[aInterfaceName]);
		});
	}
}

// Lazily define services
XPCOMUtils.defineLazyServiceGetter(this, "mPromptService", "@mozilla.org/embedcomp/prompt-service;1", "nsIPromptService");
XPCOMUtils.defineLazyServiceGetter(this, "mConsoleService", "@mozilla.org/consoleservice;1", "nsIConsoleService");
XPCOMUtils.defineLazyServiceGetter(this, "mObserverService", "@mozilla.org/observer-service;1", "nsIObserverService");
XPCOMUtils.defineLazyServiceGetter(this, "mPreferenceBranch", "@mozilla.org/preferences-service;1", "nsIPrefBranch2");
if (Cc["@mozilla.org/fuel/application;1"]) {
	XPCOMUtils.defineLazyServiceGetter(this, "Application", "@mozilla.org/fuel/application;1", "fuelIApplication");
}
else if (Cc["@mozilla.org/smile/application;1"]) {
	XPCOMUtils.defineLazyServiceGetter(this, "Application", "@mozilla.org/smile/application;1", "smileIApplication");
}
  
// Exported functions
var EXPORTED_SYMBOLS = ["log", "logError", "deleteLogFile", "openLogFile", "logging_level"];

// logging level
var logging_level = {};
logging_level["STATE"] = 1;
logging_level["TRACE"] = 2;
logging_level["DATA"] = 4;
logging_level["INFO"] = 8;
logging_level["EXTRA"] = 16;
logging_level["ERROR"] = 32;

// private variables
var _os = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULRuntime).OS;
var _EOL = /win|os[\/_]?2/i.test(_os)?"\r\n":/mac|darwin/i.test(_os)?"\r":"\n";
var _initialized = false;		// Logger module initialized
var _logFile = null;			// Current log file
var _logged_Addons = false;		// Set to true, when the current enabled add-ons have been logged (once per browsing session)
var _logEnabled = false;		// Set to true if logging is enabled
var _logLevel = 0;				// Set to the current logging level (see above)
var _printedHeader = false;		// Printed header to log file

// Message buffer to store logged events prior to initialization
var buffer = [];

// 
// Public Logging functions
//

//
// Utility to create an error message in the log without throwing an error.
//
function logError(e, force) {
	// If not an exception, just log it.
	if (!e.message) {
		log(e, force);
		return;
	}
	
	// Log Addons if haven't already
	if (!_logged_Addons) logExtensions();
		
	let location = e.stack || e.location || (e.fileName + ":" + e.lineNumber);
	try { 
		if (!_initialized) {
			buffer.push({ functionName: "logError", args: arguments});
		}
		else if (force || _logEnabled) {
			mConsoleService.logStringMessage(ADDON_NAME + " (" + (new Date).toGMTString() + "): {" + e.message + "} {" + location + "}");
			if (_logEnabled) write_log((new Date).toGMTString() + ": {" + e.message + "} {" + e.location + "}" + "\n");
		}
	}
	catch (ex) {
		report(ex);
	}
}

//
// Log info messages
//
function log(aMessage, level, force) {
	// Log Addons if haven't already
	if (!_logged_Addons) logExtensions();

	if (!level) level = "INFO";
	try {
		if (!_initialized) {
			buffer.push({ functionName: "log", args: arguments});
		}
		else if (force || (_logEnabled && (logging_level[level] & _logLevel))) {
			mConsoleService.logStringMessage(ADDON_NAME + " (" + (new Date).toGMTString() + "): " + aMessage);
			if (_logEnabled) write_log((new Date).toGMTString() + ": " + aMessage + "\n");
		}
	}
	catch (ex) { 
		report(ex); 
	}
}

// 
// Delete Log File if it exists and not logging or it's too large (> 10 MB)
//
function deleteLogFile(aForce) {
	// If log file not stored, store it.  This will throw an exception if the profile hasn't been initialized so just exit in that case.
	if (!_logFile) {
		if (!setLogFile()) return false;
	}
	
	try { 
		if (_logFile.exists() && (aForce || !_logEnabled || _logFile.fileSize > 10485760)) {
			_logFile.remove(false);
			return true;
		}
	}
	catch (ex) { 
		report(ex); 
	}
	return true;
}

//
// Open Log File
//
function openLogFile() {
	// Report error if log file not found
	if (!_logFile || !_logFile.exists() || !(_logFile instanceof Ci.nsILocalFile)) {
		try {
			let bundle = Cc["@mozilla.org/intl/stringbundle;1"].getService(Ci.nsIStringBundleService).createBundle(BUNDLE_URI);
			let errorString = bundle.GetStringFromName(ERROR_STRING_NAME);	
			mPromptService.alert(null, ADDON_NAME, errorString);
		}
		catch (ex) {
			report(ex);
		}
		return;
	}
		
	try {
		// "Double click" the log file to open it
		_logFile.launch();
	} catch (e) {
		try {
			// If launch fails (probably because it's not implemented), let the OS handler try to open the log file
			let mimeInfoService = Cc["@mozilla.org/uriloader/external-helper-app-service;1"].getService(Ci.nsIMIMEService);
			let mimeInfo = mimeInfoService.getFromTypeAndExtension(mimeInfoService.getTypeFromFile(_logFile), "txt");
			mimeInfo.preferredAction = mimeInfo.useSystemDefault;
			mimeInfo.launchWithFile(_logFile);      
		}
		catch (ex)
		{
			mPromptService.alert(null, ADDON_NAME, ex);
		}
	}
}
	

//
// Private Functions
//


//
// Set the Log File - This will throw if profile isn't lodaed yet
//
function setLogFile() {
	if (!_logFile) {
		try {
			// Get Profile folder and append log file name
			_logFile = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfD", Ci.nsIFile);
			_logFile.append(FILE_NAME);
		}
		catch (ex) { 
			_logFile = null;
			return false;
		}
	}
	return true;
}

//
// Write to Log File
// 
function write_log(aMessage) {
	// If log file not stored, store it.  This will throw an exception if the profile hasn't been initialized so just exit in that case.
	if (!_logFile) {
		if (!setLogFile()) return;
	}
	
	try {
		let stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
		// ioFlags: write only, create file, append;	Permission: read/write owner
		stream.init(_logFile, 0x02 | 0x08 | 0x10, 0600, 0);
		let cvstream = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(Ci.nsIConverterOutputStream);
		cvstream.init(stream, "UTF-8", 0, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);

		if (!_printedHeader) {
			cvstream.writeString(_EOL + "*************************************************" + _EOL);
			cvstream.writeString("******** B R O W S E R   S T A R T U P **********" + _EOL);
			cvstream.writeString("*************************************************" + _EOL);
			_printedHeader = true;
		}
		cvstream.writeString(aMessage.replace(/[\n$]/g, _EOL));
		cvstream.flush();
		cvstream.close();
	}
	catch (ex) { 
		report(ex); 
	}
}
	
//
// Log Extensions - Also log browser version
//
function logExtensions(aExtensions) {
	if (!_logEnabled) return;
	_logged_Addons = true;

	// Quit if Application doesn't exist or called from background thread (to prevent rare timing crash)
	if (!Application || !Cc["@mozilla.org/thread-manager;1"].getService().isMainThread) return;
		
	// Firefox 4.0 changes method for getting extensions to a callback function.  Use this function as the callback
	// function and check the parameter since it will be set if called back or null if called internally.
	if (!aExtensions && (typeof(Application.getExtensions) == "function")) {
		Application.getExtensions(logExtensions);
		return false;
	}
	let extensions = aExtensions ? aExtensions : Application.extensions;

	// Set to initialized.  Do this here so the addons are always logged first
	_initialized = true;
	
	// Log OS and browser version
	log("OS = " + _os, "INFO");
	log("Browser = " + Application.id + " - " + Application.name + " " + Application.version, "INFO");
	
	// Log Addons
	if (extensions.all.length) {
		log("Extensions installed and enabled:");
		for (let i=0; i<extensions.all.length; i++) {
			if (extensions.all[i].enabled) {
				log("   " + extensions.all[i].name + " " + extensions.all[i].version, "INFO");
			}
		}
	}
	
	// Log prefrences
	let prefs = extensions.get(UUID).prefs.all
	if (prefs.length) {
		log("Add-on preferences:");
		for (let i=0; i<prefs.length; i++) {
			log("   " + prefs[i].name + " = " + prefs[i].value, "INFO");
		}
	}

	// Log anything stored in the buffer
	logStoredBuffer();
}

function logStoredBuffer() {
	if (buffer) {
		let item;
		while (item = buffer.shift()) {
			switch (item.functionName) {
			case "log":
				log(item.args[0], item.args[1], item.args[2]);
				break;
			case "logError":
				logError(item.args[0], item.args[1]);
				break;
			}
		}
		delete buffer;
	}
}

// Can't use FUEL/SMILE to listen for preference changes because of bug 488587 so just use an observer
var observer = {
	observe: function(aSubject, aTopic, aData) {
		switch (aTopic)
		{
		case "nsPref:changed":
			switch(aData) 
			{
				case LOG_ENABLE_PREFERENCE_NAME:
					_logEnabled = Application.prefs.get(LOG_ENABLE_PREFERENCE_NAME).value;
					break;
				case LOG_LEVEL_PREFERENCE_NAME:
					_logLevel = Application.prefs.get(LOG_LEVEL_PREFERENCE_NAME).value;
					break;
			}
			break;
		case "final-ui-startup":
			mObserverService.removeObserver(this, "final-ui-startup");
			mObserverService.addObserver(this, "profile-change-teardown", false);
			
			// Can't use FUEL/SMILE to listen for preference changes because of bug 488587 so just use an observer
			// only need to register LOG_ENABLE_PREFERENCE_NAME because "*.logging" is in "*.logging_level" so it gets both of them
			mPreferenceBranch.addObserver(LOG_ENABLE_PREFERENCE_NAME, this, false);
			
			_logEnabled = Application.prefs.get(LOG_ENABLE_PREFERENCE_NAME).value;
			_logLevel = Application.prefs.get(LOG_LEVEL_PREFERENCE_NAME).value;
			
			// Do a conditional delete of the log file each time the application starts
			deleteLogFile();
			
			if (_logEnabled) {
				logExtensions();
			}
			else {
				// Set to initialized so we don't buffer any more
				_initialized = true;
				delete(buffer);
			}
			break;
		case "profile-change-teardown":
			// remove observers
			mObserverService.removeObserver(this, "profile-change-teardown");
			mPreferenceBranch.removeObserver(LOG_ENABLE_PREFERENCE_NAME, this);
		}
	}
}

// Initialize on the "final-ui-startup" notification because if we initialized prior to that a number of bad things will happen,
// including, the log file failing to delete and the Fuel Application component's preference observer not working.
mObserverService.addObserver(observer, "final-ui-startup", false);
const Cc = Components.classes;
const Ci = Components.interfaces
const report = Components.utils.reportError;

// Configuration Constant Settings - Change for each addon
const ADDON_NAME = "Session Manager";
const FILE_NAME = "sessionmanager_log.txt";
const LOG_ENABLE_PREFERENCE_NAME = "extensions.sessionmanager.logging";
const LOG_LEVEL_PREFERENCE_NAME = "extensions.sessionmanager.logging_level";
const BUNDLE_URI = "chrome://sessionmanager/locale/sessionmanager.properties";
const ERROR_STRING_NAME = "file_not_found";

var EXPORTED_SYMBOLS = ["log", "logError", "deleteLogFile", "openLogFile", "logging_level"];

// singleton
var gLogger = null;

// globals
var logging_level = {};
logging_level["STATE"] = 1;
logging_level["TRACE"] = 2;
logging_level["DATA"] = 4;
logging_level["INFO"] = 8;
logging_level["EXTRA"] = 16;
logging_level["ERROR"] = 32;

var deletedLogOK = false;
var errorString = "";

// 
// Public Logging functions
// Get logger singleton (this will create it if it does not exist)
//
function log(aMessage, aLevel, aForce) {
	try {
		logger().log(aMessage, aLevel, aForce);
	}
	catch(ex) {
		report(ex)
	}
}

function logError(aMessage, aForce) {
	try {
		logger().logError(aMessage, aForce);
	}
	catch(ex) {
		report(ex)
	}
}
	
function deleteLogFile(aForce) {
	try {
		logger().deleteLogFile(aForce);
	}
	catch(ex) {
		report(ex)
	}
}

function openLogFile() {
	try {
		if (!errorString) {
			let bundle = Cc["@mozilla.org/intl/stringbundle;1"].getService(Ci.nsIStringBundleService).createBundle(BUNDLE_URI);
			errorString = bundle.GetStringFromName(ERROR_STRING_NAME);	
		}
	
		logger().openLogFile();
	}
	catch(ex) {
		report(ex)
	}
}

//
// Private Functions
//

// Function to create singleton of logging class
function logger() {
	// Create singleton if it does not exist
	if (!gLogger) {
		gLogger = new loggerClass();
	}
	
	if (!deletedLogOK) {
		deletedLogOK = gLogger.deleteLogFile();
	}

	return gLogger;
}

//
// Logging Class
//
function loggerClass() {
	this._init();
}

loggerClass.prototype = {
	_logged_Addons : false,

	// 
	// Initialize variables
	//
	_init: function() {
		// Store values of preferences and listen for changes
		let pb = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch2);
		try {
			this.logEnabled = pb.getBoolPref(LOG_ENABLE_PREFERENCE_NAME);
			this.logLevel = pb.getIntPref(LOG_LEVEL_PREFERENCE_NAME);
			
			// Only add one observer
			pb.addObserver(LOG_ENABLE_PREFERENCE_NAME, this, false);
			pb.addObserver(LOG_LEVEL_PREFERENCE_NAME, this, false);
		}
		catch (ex) {
			this.logEnabled = false;
			this.logLevel = 0;
			report(ex);
		}

		// Get services
		this.mPromptService = Cc["@mozilla.org/embedcomp/prompt-service;1"].getService(Ci.nsIPromptService);
		this.mConsoleService = Cc['@mozilla.org/consoleservice;1'].getService(Ci.nsIConsoleService);
	},

	observe: function(aSubject, aTopic, aData)
	{
		switch (aTopic)
		{
			case "nsPref:changed":
				let pb = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch);
				try {
					switch(aData) 
					{
						case LOG_ENABLE_PREFERENCE_NAME:
							this.logEnabled = pb.getBoolPref(LOG_ENABLE_PREFERENCE_NAME);
							break;
						case LOG_LEVEL_PREFERENCE_NAME:
							this.logLevel = pb.getIntPref(LOG_LEVEL_PREFERENCE_NAME);
							break;
					}
					break;
				}
				catch(ex) {
					report(ex);
				}
		}
	},
	
	//
	// Utility to create an error message in the log without throwing an error.
	//
	logError: function(e, force) {
		// If not an exception, just log it.
		if (!e.message) {
			this.log(e, force);
			return;
		}
	
		// Log Addons if haven't already and EOL character exists
		if (!this._logged_Addons && this.mEOL) this.logExtensions();
		
		try { 
			if (force || this.logEnabled) {
				this.mConsoleService.logStringMessage(ADDON_NAME + " (" + (new Date).toGMTString() + "): {" + e.message + "} {" + e.location + "}");
				this.write_log((new Date).toGMTString() + ": {" + e.message + "} {" + e.location + "}" + "\n");
			}
		}
		catch (ex) {
			dump (ex + "\n")
		}
	},

	//
	// Log info messages
	//
	log: function(aMessage, level, force) {
		// Log Addons if haven't already and EOL character exists
		if (!this._logged_Addons && this.mEOL) this.logExtensions();
	
		if (!level) level = "INFO";
		try {
			if (force || (this.logEnabled && (logging_level[level] & this.logLevel))) {
				this.mConsoleService.logStringMessage(ADDON_NAME + " (" + (new Date).toGMTString() + "): " + aMessage);
				this.write_log((new Date).toGMTString() + ": " + aMessage + "\n");
			}
		}
		catch (ex) { 
			dump(ex + "\n"); 
		}
	},

	//
	// Open Log File
	//
	openLogFile: function() {
		if (!this.logFile.exists() || !(this.logFile instanceof Ci.nsILocalFile)) {
			this.mPromptService.alert(null, ADDON_NAME, errorString);
			return;
		}
		try {
			// "Double click" the log file to open it
			this.logFile.launch();
		} catch (e) {
			try {
				// If launch fails (probably because it's not implemented), let the OS handler try to open the log file
				let mimeInfoService = Cc["@mozilla.org/uriloader/external-helper-app-service;1"].getService(Ci.nsIMIMEService);
				let mimeInfo = mimeInfoService.getFromTypeAndExtension(mimeInfoService.getTypeFromFile(this.logFile), "txt");
				mimeInfo.preferredAction = mimeInfo.useSystemDefault;
				mimeInfo.launchWithFile(this.logFile);      
			}
			catch (ex)
			{
				this.mPromptService.alert(null, ADDON_NAME, ex);
			}
		}
	},
	
	//
	// Set the Log File - This will throw if profile isn't lodaed yet
	//
	setLogFile: function() {
		if (!this.logFile) {
			try {
				// Get Profile folder and append log file name
				this.logFile = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfD", Ci.nsILocalFile).clone();
				this.logFile.append(FILE_NAME);
			}
			catch (ex) { 
				this.logFile = null;
				return false;
			}
		}
		return true;
	},

	// 
	// Delete Log File if it exists and not logging or it's too large (> 10 MB)
	//
	deleteLogFile: function(aForce) {
		// If log file not stored, store it.  This will throw an exception if the profile hasn't been initialized so just exit in that case.
		if (!this.logFile) {
			if (!this.setLogFile()) return false;
		}
	
		try { 
			if (this.logFile.exists() && (aForce || !this.logEnabled || this.logFile.fileSize > 10485760)) {
				this.logFile.remove(false);
				return true;
			}
		}
		catch (ex) { 
			dump(ex + "\n"); 
		}
		return true;
	},
				 
	//
	// Write to Log File
	// 
	write_log: function(aMessage) {
		// If log file not stored, store it.  This will throw an exception if the profile hasn't been initialized so just exit in that case.
		if (!this.logFile) {
			if (!this.setLogFile()) return;
		}
	
		// If EOL character isn't stored, try to get it
		if (!this.mEOL) {
			// Try to get the most recent window to find the platform
			let recentWindow = Components.classes["@mozilla.org/appshell/window-mediator;1"].getService(Components.interfaces.nsIWindowMediator).getMostRecentWindow(null);
			let platform = (recentWindow ? recentWindow.navigator.platform : null);
			
			if (platform) {
				// Set EOL character
				this.mEOL = /win|os[\/_]?2/i.test(platform)?"\r\n":/mac/i.test(platform)?"\r":"\n";
			}
		}
	
		try {
			let stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
			// ioFlags: write only, create file, append;	Permission: read/write owner
			stream.init(this.logFile, 0x02 | 0x08 | 0x10, 0600, 0);
			let cvstream = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(Ci.nsIConverterOutputStream);
			cvstream.init(stream, "UTF-8", 0, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);

			cvstream.writeString(aMessage.replace(/[\n$]/g, (this.mEOL ? this.mEOL : "\n")));
			cvstream.flush();
			cvstream.close();
		}
		catch (ex) { 
			dump(ex + "\n"); 
		}
	},
	
	//
	// Log Extensions - Also log browser version
	//
	logExtensions: function() {
		if (!this.logEnabled) return;
		this._logged_Addons = true;

		let Application = null;
		if (Cc["@mozilla.org/fuel/application;1"]) {
			Application = Cc["@mozilla.org/fuel/application;1"].getService(Ci.fuelIApplication);
		} else if (Cc["@mozilla.org/smile/application;1"]) {
			Application = Cc["@mozilla.org/smile/application;1"].getService(Ci.smileIApplication);
		}
		if (!Application) return;
		
		// Log browser version
		this.log("Browser = " + Application.id + " - " + Application.name + " " + Application.version, "INFO");
		
		// Log Addons
		let extensions = Application.extensions.all;
		if (extensions.length) {
			this.log("Extensions installed and enabled:");
			for (let i=0; i<extensions.length; i++) {
				if (extensions[i].enabled) {
					this.log(extensions[i].name + " " + extensions[i].version, "INFO");
				}
			}
		}
	}
}
const Cc = Components.classes;
const Ci = Components.interfaces
const report = Components.utils.reportError;

var EXPORTED_SYMBOLS = ["logger", "logging_level"];

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

// Function to create singleton of logging class
function logger(aFilename, aAddonName, aLogEnablePrefereneceName, aLogLevelPreferenceName) {
	// If parameters or window is missing just return the current gLogger (if it exists)
	if (!aFilename || !aAddonName || !aLogEnablePrefereneceName || !aLogLevelPreferenceName) {
		return gLogger;
	}

	// Try to get the most recent window to find the platform
	let recentWindow = Components.classes["@mozilla.org/appshell/window-mediator;1"].getService(Components.interfaces.nsIWindowMediator).getMostRecentWindow(null);
	let platform = (recentWindow ? recentWindow.navigator.platform : null);
	
	if (!platform) return gLogger;
	
	// Create singleton if it does not exist and call the deleteLogFile function
	if (!gLogger) {
		gLogger = new loggerClass(aFilename, aAddonName, aLogEnablePrefereneceName, aLogLevelPreferenceName, platform);
	}
	gLogger.deleteLogFile();

	return gLogger;
}

//
// Logging Class
//
function loggerClass(aFilename, aAddonName, aLogEnablePrefereneceName, aLogLevelPreferenceName, aPlatform) {
	this._init(aFilename, aAddonName, aLogEnablePrefereneceName, aLogLevelPreferenceName, aPlatform);
}

loggerClass.prototype = {
	// 
	// Initialize variables
	//
	_init: function(aFilename, aAddonName, aLogEnablePrefereneceName, aLogLevelPreferenceName, aPlatform) {
		this.addonName = aAddonName;
		this.logEnablePrefereneceName = aLogEnablePrefereneceName;
		this.logLevelPreferenceName = aLogLevelPreferenceName;
		
		// Store values of preferences and listen for changes
		let pb = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch2);
		try {
			this.logEnabled = pb.getBoolPref(aLogEnablePrefereneceName);
			this.logLevel = pb.getIntPref(aLogLevelPreferenceName);
			
			// Only add one observer
			pb.addObserver(aLogEnablePrefereneceName, this, false);
			pb.addObserver(aLogLevelPreferenceName, this, false);
		}
		catch (ex) {
			this.logEnabled = false;
			this.logLevel = 0;
			report(ex);
		}

		// Get Profile folder and append log file name
		this.logFile = Cc["@mozilla.org/file/directory_service;1"].getService(Ci.nsIProperties).get("ProfD", Ci.nsILocalFile).clone();
		this.logFile.append(aFilename);
	
		// Get services
		this.mPromptService = Cc["@mozilla.org/embedcomp/prompt-service;1"].getService(Ci.nsIPromptService);
		this.mConsoleService = Cc['@mozilla.org/consoleservice;1'].getService(Ci.nsIConsoleService);
		
		// Get EOL character
		this.mEOL = /win|os[\/_]?2/i.test(aPlatform)?"\r\n":/mac/i.test(aPlatform)?"\r":"\n";
	
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
						case this.logEnablePrefereneceName:
							this.logEnabled = pb.getBoolPref(this.logEnablePrefereneceName);
							break;
						case this.logLevelPreferenceName:
							this.logLevel = pb.getIntPref(this.logLevelPreferenceName);
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
		try { 
			if (force || this.logEnabled) {
				let consoleError = Cc['@mozilla.org/scripterror;1'].createInstance(Ci.nsIScriptError);
				consoleError.init(e.message, e.fileName, e.lineNumber, e.lineNumber, e.columnNumber, 0, null);

				this.mConsoleService.logStringMessage(this.addonName + " (" + (new Date).toGMTString() + "): " + consoleError.toString());
				this.write_log((new Date).toGMTString() + "): " + consoleError + "\n");
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
		if (!level) level = "INFO";
		try {
			if (force || (this.logEnabled && (logging_level[level] & this.logLevel))) {
				this.mConsoleService.logStringMessage(this.addonName + " (" + (new Date).toGMTString() + "): " + aMessage);
				this.write_log((new Date).toGMTString() + "): " + aMessage + "\n");
			}
		}
		catch (ex) { 
			dump(ex + "\n"); 
		}
	},

	//
	// Open Log File
	//
	openLogFile: function(aErrorString) {
		if (!this.logFile.exists() || !(this.logFile instanceof Ci.nsILocalFile)) {
			this.mPromptService.alert(null, this.addonName, aErrorString);
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
				this.mPromptService.alert(null, this.addonName, ex);
			}
		}
	},

	// 
	// Delete Log File if it exists and not logging or it's too large (> 10 MB)
	//
	deleteLogFile: function(aForce) {
		try { 
			if (this.logFile.exists() && (aForce || !this.logEnabled || this.logFile.fileSize > 10485760)) {
				this.logFile.remove(false);
			}
		}
		catch (ex) { 
			dump(ex + "\n"); 
		}
	},
				 
	//
	// Write to Log File
	// 
	write_log: function(aMessage) {
		try {
			let stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
			// ioFlags: write only, create file, append;	Permission: read/write owner
			stream.init(this.logFile, 0x02 | 0x08 | 0x10, 0600, 0);
			let cvstream = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(Ci.nsIConverterOutputStream);
			cvstream.init(stream, "UTF-8", 0, Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);

			cvstream.writeString(aMessage.replace(/[\n$]/g, this.mEOL));
			cvstream.flush();
			cvstream.close();
		}
		catch (ex) { 
			dump(ex + "\n"); 
		}
	},
	
	//
	// Log Extensions
	//
	logExtensions: function() {
		if (!this.logEnabled) return;
		let Application = Components.classes["@mozilla.org/fuel/application;1"].getService(Components.interfaces.fuelIApplication);
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
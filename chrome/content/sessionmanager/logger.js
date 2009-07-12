gSessionManager.logFileName = "sessionmanager_log.txt";

//
// Utility to create an error message in the log without throwing an error.
//
gSessionManager.logError = function(e, force) {
	try { 
		if (force || this.mPref_logging) {
			var consoleService = this.mComponents.classes['@mozilla.org/consoleservice;1'].getService(this.mComponents.interfaces.nsIConsoleService);
			var consoleError = this.mComponents.classes['@mozilla.org/scripterror;1'].createInstance(this.mComponents.interfaces.nsIScriptError);

			consoleError.init(e.message, e.fileName, e.lineNumber, e.lineNumber, e.columnNumber, 0, null);

			consoleService.logStringMessage("Session Manager (" + (new Date).toGMTString() + "): " + consoleError.toString());
			this.write_log((new Date).toGMTString() + "): " + consoleError + "\n");
		}
	}
	catch (ex) {
		dump (ex + "\n")
	}
}

//
// Log info messages
//
gSessionManager.log = function(aMessage, force) {
	try {
		if (force || this.mPref_logging) {
			var consoleService = this.mComponents.classes['@mozilla.org/consoleservice;1'].getService(this.mComponents.interfaces.nsIConsoleService);
			consoleService.logStringMessage("Session Manager (" + (new Date).toGMTString() + "): " + aMessage);
			this.write_log((new Date).toGMTString() + "): " + aMessage + "\n");
		}
	}
	catch (ex) { 
		dump(ex + "\n"); 
	}
}

//
// Open Log File
//
gSessionManager.openLogFile = function() {
	var logFile = this.getProfileFile(this.logFileName);
	if (!logFile.exists() || !(logFile instanceof this.mComponents.interfaces.nsILocalFile)) {
		var ex = new Components.Exception(this._string("file_not_found"));
		this.ioError(ex);
		return;
	}
	try {
		// "Double click" the log file to open it
		logFile.launch();
	} catch (e) {
		try {
			// If launch fails (probably because it's not implemented), let the OS handler try to open the log file
			var mimeInfoService = this.mComponents.classes["@mozilla.org/uriloader/external-helper-app-service;1"].getService(this.mComponents.interfaces.nsIMIMEService);
			var mimeInfo = mimeInfoService.getFromTypeAndExtension(mimeInfoService.getTypeFromFile(logFile), "txt");
			mimeInfo.preferredAction = mimeInfo.useSystemDefault;
			mimeInfo.launchWithFile(logFile);      
		}
		catch (ex)
		{
			this.ioError(ex);
		}
	}
}

// 
// Delete Log File if it exists and not logging or it's too large (> 1 MB)
//
gSessionManager.deleteLogFile = function(aForce) {
	try { 
		var logFile = this.getProfileFile(this.logFileName);

		if (logFile.exists() && (aForce || !this.mPref_logging || logFile.fileSize > 1048576)) {
			logFile.remove(false);
		}
	}
	catch (ex) { 
		dump(ex + "\n"); 
	}
}
				 
//
// Write to Log File
// 
gSessionManager.write_log = function(aMessage) {
	try {
		var logFile = this.getProfileFile(this.logFileName);

		var stream = this.mComponents.classes["@mozilla.org/network/file-output-stream;1"].createInstance(this.mComponents.interfaces.nsIFileOutputStream);
		// ioFlags: write only, create file, append;	Permission: read/write owner
		stream.init(logFile, 0x02 | 0x08 | 0x10, 0600, 0);
		var cvstream = this.mComponents.classes["@mozilla.org/intl/converter-output-stream;1"].createInstance(this.mComponents.interfaces.nsIConverterOutputStream);
		cvstream.init(stream, "UTF-8", 0, this.mComponents.interfaces.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);

		cvstream.writeString(aMessage.replace(/[\n$]/g, this.mEOL));
		cvstream.flush();
		cvstream.close();
	}
	catch (ex) { 
		dump(ex + "\n"); 
	}
}

//
// Log Extensions
// Adopted from Mr Tech Toolkit addon - http://www.mrtech.com/extensions/
// Can't use nsiExtensionManager since it doesn't know what addons are disabled
//
gSessionManager.logExtensions = function() {
	try {
		function getRDFValue(thisElement, thisType) {
			try { 
				var thisArc = RDFService.GetResource("http://www.mozilla.org/2004/em-rdf#" + thisType);
				var target = extensionDS.GetTarget(thisElement, thisArc, true);
        
				// Null Safety Check for null crasher on sorting names
				// Return blank string to avoid issue with name or description being blank
       
				if (target instanceof Components.interfaces.nsIRDFLiteral || target instanceof Components.interfaces.nsIRDFInt)
					return (target.Value == null) ? "" : target.Value
			} catch(ex) {}
      
			return "";
		}

		var RDFService = Components.classes["@mozilla.org/rdf/rdf-service;1"].getService(Components.interfaces.nsIRDFService);
		var Container = Components.classes["@mozilla.org/rdf/container;1"].getService(Components.interfaces.nsIRDFContainer);
		var extensionDS= Components.classes["@mozilla.org/extensions/manager;1"].getService(Components.interfaces.nsIExtensionManager).datasource;

		var whichRoot = "urn:mozilla:item:root";

		var root = RDFService.GetResource(whichRoot);

		/* Pre-generate GUID list for name-id matchup later in loop */
		var item_list = {};
  
		var myExtensionManager = Components.classes["@mozilla.org/extensions/manager;1"].getService(Components.interfaces.nsIExtensionManager);

		// get extensions guids
		var items = myExtensionManager.getItemList(Components.interfaces.nsIUpdateItem.TYPE_EXTENSION, { });

		if (items) {
			for (x in items) {
				item_list[items[x].name] = items[x];
			}
		}
		items = null;
		/* End Pre-generating GUID list */
		
		Container.Init(extensionDS, root);

		var elements = Container.GetElements();

		this.log("Extensions installed and enabled:");
		while(elements.hasMoreElements()) {
			var element = elements.getNext();
			element.QueryInterface(Components.interfaces.nsIRDFResource);

			var thisType = getRDFValue(element, "type");
			if (thisType == 2) {
				var name = getRDFValue(element, "name");
				var disabled = getRDFValue(element, "isDisabled");
			
				if ((name.length > 0) && (!disabled || disabled != "true")) {
					var version = getRDFValue(element, "version");
					var minAppVersion = item_list[name].minAppVersion;
					var maxAppVersion = item_list[name].maxAppVersion;
					var homepageURL = getRDFValue(element, "homepageURL");

					if (homepageURL.indexOf("www.") == 0) {
						homepageURL = "http://" + homepageURL; 
					}
			
					this.log(name + " " + version + " (" + minAppVersion + "-" + maxAppVersion + ")" + (homepageURL ? (" - " + homepageURL) : ""));
				}
			}
		}
		item_list = null;
		this.log("");
	} 
	catch(ex) { 
		this.logError(ex);
	}
}
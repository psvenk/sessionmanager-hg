const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

// import modules
Cu.import("resource://sessionmanager/modules/logger.jsm");

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
XPCOMUtils.defineLazyServiceGetter(this, "mObserverService", "@mozilla.org/observer-service;1", "nsIObserverService");
XPCOMUtils.defineLazyServiceGetter(this, "mPreferenceBranch", "@mozilla.org/preferences-service;1", "nsIPrefBranch2");
XPCOMUtils.defineLazyServiceGetter(this, "NATIVE_JSON", "@mozilla.org/dom/json;1", "nsIJSON");
if (Cc["@mozilla.org/fuel/application;1"]) {
	XPCOMUtils.defineLazyServiceGetter(this, "Application", "@mozilla.org/fuel/application;1", "fuelIApplication");
}
else if (Cc["@mozilla.org/smile/application;1"]) {
	XPCOMUtils.defineLazyServiceGetter(this, "Application", "@mozilla.org/smile/application;1", "smileIApplication");
}

// Constants
const OLD_PREFERENCE_ROOT = "extensions.sessionmanager.";
const PREFERENCE_ROOT = "extensions.{1280606b-2510-4fe0-97ef-9b5a22eafe30}.";
const SM_UUID = "{1280606b-2510-4fe0-97ef-9b5a22eafe30}";

var EXPORTED_SYMBOLS = ["gPreferenceManager"];

var smPreferenceBranch = null;
var _initialized = false;

//
// API functions
//

var gPreferenceManager = {

	// Call this as a function instead of running internally because it needs to run before the session_manager module's initialize function
	initialize: function()
	{
		if (!_initialized) {
			smPreferenceBranch = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefService).getBranch(PREFERENCE_ROOT).QueryInterface(Ci.nsIPrefBranch2);
			movePreferenceRoot();
			_initialized = true;
		}
	},

	has: function(aName, aUseRootBranch) 
	{
		return Application.prefs.has((aUseRootBranch ? "" : PREFERENCE_ROOT) + aName);
	},

	get: function(aName, aDefault, aUseRootBranch) 
	{
		// calling from background threads causes a crash, so use nsiPrefBranch in that case - Bug 565445
		if (Cc["@mozilla.org/thread-manager;1"].getService().isMainThread) {
			return Application.prefs.getValue((aUseRootBranch ? "" : PREFERENCE_ROOT) + aName, aDefault);
		}
		else {
			try
			{
				let pb = (aUseRootBranch)?mPreferenceBranch:smPreferenceBranch;
				switch (pb.getPrefType(aName))
				{
					case pb.PREF_STRING:
						// handle unicode values
						return pb.getComplexValue(aName,Ci.nsISupportsString).data
					case pb.PREF_BOOL:
						return pb.getBoolPref(aName);
					case pb.PREF_INT:
						return pb.getIntPref(aName);
				}
			}
			catch (ex) { }
			
			return aDefault;
		}
	},

	set: function(aName, aValue, aUseRootBranch) 
	{
		let forceSave = checkForForceSave(aName, aValue, aUseRootBranch);
		
		try {
			Application.prefs.setValue((aUseRootBranch ? "" : PREFERENCE_ROOT) + aName, aValue);
			if (forceSave) mObserverService.notifyObservers(null,"sessionmanager-preference-save",null);
		} 
		catch(ex) { logError(ex); }
	},

	delete: function(aName, aUseRootBranch) 
	{
		let pref = Application.prefs.get((aUseRootBranch ? "" : PREFERENCE_ROOT) + aName);
		if (pref && pref.modified) {
			pref.reset();
		}
	},
	
	// Delete warning prompt preferences which have the format of "no_....._prompt"
	resetWarningPrompts: function(aExtensions)
	{
		let extensions = Application.extensions ? Application.extensions : aExtensions;
		if (!extensions) {
			if (typeof(Application.getExtensions) == "function") {
				Application.getExtensions(gPreferenceManager.resetWarningPrompts);
			}
			return;
		}
	
		let prefs = extensions.get(SM_UUID).prefs.all;
		if (prefs.length) {
			prefs = prefs.filter(function(element, index, array) {
				return element.name.match(/no_(.*)_prompt/);
			});
			prefs.forEach(function(pref) {
				pref.reset();
			});
		}
	},
	
	import: function()
	{
		let file = chooseFile(false);
		if (!file) return;
	
		let prefsString = "";  
		let success = true;
		let reason = "";
		try {
			let fstream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);  
			let cstream = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);  
			fstream.init(file, -1, 0, 0);  
			cstream.init(fstream, "UTF-8", 0, 0); // you can use another encoding here if you wish  

			let (str = {}) {  
				let read = 0;  
				do {   
					read = cstream.readString(0xffffffff, str); // read as much as we can and put it in str.value  
					prefsString += str.value;  
				} while (read != 0);  
			}  
			cstream.close(); // this closes fstream  		
		
			let prefs = NATIVE_JSON.decode(prefsString);
			if (prefs.length) {
				for (let i=0; i<prefs.length; i++) {
					this.set(prefs[i].name, prefs[i].value);
				}
			}
		} 
		catch(ex) { 
			success = false;
			reason = ex;
			logError(ex); 
		}
		
		let window = Cc['@mozilla.org/appshell/window-mediator;1'].getService(Ci.nsIWindowMediator).getMostRecentWindow("SessionManager:Options");
		let bundle = Cc["@mozilla.org/intl/stringbundle;1"].getService(Ci.nsIStringBundleService).createBundle("chrome://sessionmanager/locale/sessionmanager.properties");
		let text = success ? bundle.GetStringFromName("import_successful") :  (bundle.GetStringFromName("import_failed") + " - " + reason);
		Cc["@mozilla.org/embedcomp/prompt-service;1"].getService(Ci.nsIPromptService).alert(window, bundle.GetStringFromName("import_prompt"), text);
	},
	
	export: function(aExtensions)
	{
		let extensions = Application.extensions ? Application.extensions : aExtensions;
		if (!extensions) {
			if (typeof(Application.getExtensions) == "function") {
				Application.getExtensions(gPreferenceManager.export);
			}
			return;
		}
	
		let file = chooseFile(true);
		if (!file) return;
	
		let success = true;
		let reason = "";
		try {
			let prefs = extensions.get(SM_UUID).prefs.all;
			if (prefs.length) {
			
				let myprefs = [];
				for (let i=0; i<prefs.length; i++) {
					myprefs.push({ name: prefs[i].name, value: prefs[i].value });
				}
				prefsString = NATIVE_JSON.encode(myprefs);
				
				// file is nsIFile, prefsString is a string
				let foStream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);

				foStream.init(file, 0x02 | 0x08 | 0x20, -1, 0); 
				// write, create, truncate
				// 664 = u:rwx, g:rw, u:r

				// if you are sure there will never ever be any non-ascii text in data you can 
				// also call foStream.writeData directly
				let converter = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(Ci.nsIConverterOutputStream);
				converter.init(foStream, "UTF-8", 0, 0);
				converter.writeString(prefsString);
				converter.flush();
				converter.close(); // this closes foStream			
			}
		}
		catch(ex) { 
			success = false;
			reason = ex;
			logError(ex); 
		}
		
		let window = Cc['@mozilla.org/appshell/window-mediator;1'].getService(Ci.nsIWindowMediator).getMostRecentWindow("SessionManager:Options");
		let bundle = Cc["@mozilla.org/intl/stringbundle;1"].getService(Ci.nsIStringBundleService).createBundle("chrome://sessionmanager/locale/sessionmanager.properties");
		let text = success ? bundle.GetStringFromName("export_successful") :  (bundle.GetStringFromName("export_failed") + " - " + reason);
		Cc["@mozilla.org/embedcomp/prompt-service;1"].getService(Ci.nsIPromptService).alert(window, bundle.GetStringFromName("export_prompt"), text);
	},

	// Use Preference Service for observing instead of FUEL because FUEL's preference observer is not working - Bug 488587
	observe: function(aPrefName, aObserver, aOwnsWeak, aUseRootBranch)
	{
		(aUseRootBranch ? mPreferenceBranch : smPreferenceBranch).addObserver(aPrefName, aObserver, aOwnsWeak);
	},

	unobserve: function(aPrefName, aObserver, aUseRootBranch)
	{
		try {
			((aUseRootBranch)?mPreferenceBranch:smPreferenceBranch).removeObserver(aPrefName, aObserver);
		}
		catch(ex) { logError(ex); }
	}
}

//	
// private functions
//

// Certain preferences should be force saved in case of a crash
function checkForForceSave(aName, aValue, aUseRootBranch)
{
	let names = [ "_autosave_values" ];
	
	for (let i=0; i<names.length; i++) {
		if (aName == names[i]) {
			let currentValue = gPreferenceManager.get(aName, null, aUseRootBranch);
			return (currentValue != aValue);
		}
	}
	return false;
}

// Move preferences from old preference branch to new standard one that uses extension GUID
function movePreferenceRoot()
{
	// If old values exist
	if (Application.prefs.has(OLD_PREFERENCE_ROOT + "version")) {
		let prefBranch = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefService).getBranch(OLD_PREFERENCE_ROOT);
		let count = {};
		let children = prefBranch.getChildList("",count);
		for (let i=0; i < children.length; i++) {
			try {
				let pref = Application.prefs.get(OLD_PREFERENCE_ROOT + children[i]);
				if (pref && pref.modified) {
					Application.prefs.setValue(PREFERENCE_ROOT + children[i], pref.value);
					pref.reset();
				}
			} catch(ex) {
				logError(ex);
			}
		}
	}
}

// Pick file to save/load preferences
// aSave true = save
// aSave false = load
function chooseFile(aSave)
{
	let bundle = Cc["@mozilla.org/intl/stringbundle;1"].getService(Ci.nsIStringBundleService).createBundle("chrome://sessionmanager/locale/sessionmanager.properties");
	let nsIFilePicker = Ci.nsIFilePicker;
	let filepicker = Cc["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
	let window = Cc['@mozilla.org/appshell/window-mediator;1'].getService(Ci.nsIWindowMediator).getMostRecentWindow("SessionManager:Options");
	
	filepicker.init(window, bundle.GetStringFromName((aSave ? "export" : "import") + "_prompt"), (aSave ? nsIFilePicker.modeSave : nsIFilePicker.modeOpen));
	filepicker.appendFilter(bundle.GetStringFromName("settings_file_extension_description"), "*.session_manager_settings");
	filepicker.defaultString = bundle.GetStringFromName("default_settings_file_name");
	filepicker.defaultExtension = bundle.GetStringFromName("settings_file_extension");
	var ret = filepicker.show();
	if (ret == nsIFilePicker.returnOK || ret == nsIFilePicker.returnReplace) {
		return filepicker.file;
	}
	else return null;
}
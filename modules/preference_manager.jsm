const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;

// import modules
Cu.import("resource://sessionmanager/modules/logger.jsm");

// Services
const Application = (Cc["@mozilla.org/fuel/application;1"]) ? Cc["@mozilla.org/fuel/application;1"].getService(Ci.fuelIApplication) :  
                    ((Cc["@mozilla.org/smile/application;1"]) ? Cc["@mozilla.org/smile/application;1"].getService(Ci.smileIApplication) : null);
const mObserverService = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);
const mPreferenceBranch = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch2);				

// Constants
const OLD_PREFERENCE_ROOT = "extensions.sessionmanager.";
const PREFERENCE_ROOT = "extensions.{1280606b-2510-4fe0-97ef-9b5a22eafe30}.";

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
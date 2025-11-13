const VENDOR = "Behringer";
const EXTENSION_NAME = "DDX3216";
const VERSION = "0.7.0";
const AUTHOR = "Felix Gertz";
const DEVICE_ID = 0x7f;
const NUM_FADERS = 66;
const MUTE_CC_BASE = 33; // CC 33..64 -> mute buttons 1..32
const SELECT_CC_BASE = 65; // CC 65..96 -> select buttons 1..32 (used to open/close groups)
const PAN_CC_BASE = 97; // CC 97..128 -> pan knobs for channels 1..32
const FEEDBACK_INTERVAL_MS = 300;
const lastFaderReceiveAction = {};
loadAPI(24);
host.defineController(VENDOR, EXTENSION_NAME, VERSION, "57fb8818-a6a6-4a23-9413-2a1a5aea3ce1", AUTHOR);
host.setShouldFailOnDeprecatedUse(true);
host.defineMidiPorts(1, 1);
host.addDeviceNameBasedDiscoveryPair(["DDX3216"], ["DDX3216"]);
let midiIn;
let midiOut;
let trackBank;
let cursorTrack;
let midiChannelSetting;
let faderValueMappingSetting;
/* Helper */
function getMidiChannel() {
    const midiChannel = midiChannelSetting.getRaw() - 1;
    return midiChannel === -1 ? undefined : midiChannel;
}
function getDeviceByte(midiChannel) {
    if (midiChannel === undefined) {
        return 0x60;
    }
    return 0x40 | (midiChannel & 0x0f);
}
function constructSysEx(command) {
    return `F0002032${getDeviceByte(getMidiChannel())
        .toString(16)
        .padStart(2, "0")}0B${command}F7`;
}
/* To DDX3216 */
// Takes and sends the sysex volume value from 0 to 1472
// ddx_dB = -80 + value/16
function sendSysExVolumeToMixer(faderIndex, sysExVolume) {
    const lastActionTimestamp = lastFaderReceiveAction[faderIndex];
    if (lastActionTimestamp != null &&
        Date.now() - FEEDBACK_INTERVAL_MS <= lastActionTimestamp) {
        return;
    }
    const high7bit = ((sysExVolume >> 7) & 0x7f).toString(16).padStart(2, "0");
    const low7bit = (sysExVolume & 0x7f).toString(16).padStart(2, "0");
    // PARAMCHANGE_FUNC_TYPE MSG_COUNT CHANNEL/FADERINDEX VOLUME_FUNCTION_CODE VALUE
    const command = `2001${faderIndex
        .toString(16)
        .padStart(2, "0")}01${high7bit}${low7bit}`.toUpperCase();
    const sysex = constructSysEx(command);
    midiOut.sendSysex(sysex);
}
function displayedVolumeChanged(faderIndex, bitwigDisplayValue) {
    if (faderValueMappingSetting.get() !== "exact") {
        return;
    }
    let dbVolume = parseFloat(bitwigDisplayValue);
    const isInf = bitwigDisplayValue.includes("Inf");
    if (!isInf && isNaN(dbVolume)) {
        return;
    }
    if (dbVolume < -80 || isInf) {
        dbVolume = -80;
    }
    else if (dbVolume > 12) {
        dbVolume = 12;
    }
    const sysExVolume = Math.round((dbVolume + 80) * 16);
    sendSysExVolumeToMixer(faderIndex, sysExVolume);
    // midiOut.sendMidi(0xB0 | MIDI_CHANNEL, FADER_CC_BASE + faderIndex, ccVal);
}
function normalizedVolumeChanged(faderIndex, normalizedValue) {
    if (faderValueMappingSetting.get() !== "full range") {
        return;
    }
    const track = trackBank.getItemAt(faderIndex);
    normalizedValue = track.volume().get();
    sendSysExVolumeToMixer(faderIndex, 1472 * normalizedValue);
}
/* From DDX3216 */
function dbToNormalized(db) {
    if (db <= -80.0) {
        return 0;
    }
    if (db >= 6.0) {
        return 1;
    }
    return Math.pow(10, (db - 6) / 60);
}
function setBitwigFaderVolumeBySysexValue(faderIndex, sysexVolume, settingsFaderValueMapping) {
    try {
        const track = trackBank.getItemAt(faderIndex);
        let normalizedVolume;
        if (settingsFaderValueMapping === "exact") {
            const dbValue = sysexVolume / 16 - 80;
            normalizedVolume = dbToNormalized(dbValue);
        }
        else {
            normalizedVolume = sysexVolume / 1472;
        }
        track.volume().setImmediately(normalizedVolume);
        lastFaderReceiveAction[faderIndex] = Date.now();
    }
    catch (error) {
        host.errorln(`Could not set Bitwig fader volume by sysex ${error}`);
    }
}
/* General control functions */
function processIncomingSysex(sysexData) {
    const settingsMidiChannel = getMidiChannel();
    const settingsFaderValueMapping = faderValueMappingSetting.get();
    const regexp = /f0002032([0-F]{2})0b([0-F]{2})([0-F]{2})(.*)F7/gim;
    const [, midiChannel, functionType, msgCount, messagesString] = regexp.exec(sysexData);
    const messages = messagesString.match(/.{1,8}/g);
    if (settingsMidiChannel !== undefined &&
        parseInt(midiChannel, 16) !== settingsMidiChannel) {
        println(`Incoming midi channel ${parseInt(midiChannel, 16) + 1} does not match set channel ${settingsMidiChannel + 1}.`);
        return;
    }
    println(`Midi Channel: ${midiChannel} fnType: ${functionType} msgCount: ${msgCount} messages: ${messages.join("|")}`);
    if (parseInt(msgCount, 16) !== messages.length) {
        host.errorln(`Message count does not match messages length`);
    }
    // Function: Parameter change
    if (functionType === "20") {
        if (messages == null) {
            host.errorln("messages is null");
            return;
        }
        messages.forEach((message, i) => {
            if (message == null) {
                host.errorln("message is null");
                return;
            }
            const paramRegex = /([0-F]{2})([0-F]{2})([0-F]{2})([0-F]{2})/gim;
            const [, faderIndex, functionCode, highWord, lowWord] = paramRegex.exec(message);
            let sysexValue = Number((parseInt(highWord, 16) << 7) | parseInt(lowWord, 16));
            println(`faderIndex: ${faderIndex} fnType: ${functionCode} highWord: ${highWord} lowWord: ${lowWord} sysexValue: ${sysexValue}`);
            if (isNaN(sysexValue)) {
                return;
            }
            const faderIndexInt = parseInt(faderIndex, 16);
            // Volume
            if (functionCode === "01") {
                setBitwigFaderVolumeBySysexValue(faderIndexInt, sysexValue, settingsFaderValueMapping);
            }
        });
    }
}
function createBitwigSettings() {
    midiChannelSetting = host
        .getPreferences()
        .getNumberSetting("MIDI channel (0 = omni)", "Connection", 0, 16, 1, "", 1);
    faderValueMappingSetting = host.getPreferences().getEnumSetting("dB mapping", "Fader", ["exact", "full range"], "exact");
    host.getPreferences().getStringSetting("Developed by Felix Gertz", "Support", 128, "Support me via https://aldipower.bandcamp.com/album/das-reihenhaus and purchase the album. Thank you so much.");
}
function init() {
    createBitwigSettings();
    midiIn = host.getMidiInPort(0);
    midiOut = host.getMidiOutPort(0);
    // Create a track bank representing the visible area of the mixer
    trackBank = host.createMainTrackBank(NUM_FADERS, 0, 0);
    // Keep a cursor for global navigation/selection actions
    cursorTrack = host.createCursorTrack(0, 0);
    for (let i = 0; i < NUM_FADERS; i++) {
        const t = trackBank.getItemAt(i);
        t.volume().markInterested();
        t.pan().markInterested();
        t.mute().markInterested();
        t.volume()
            .displayedValue()
            .addValueObserver((displayedValue) => {
            displayedVolumeChanged(i, displayedValue);
        });
        t.volume().value().addRawValueObserver((value) => {
            normalizedVolumeChanged(i, value);
        });
    }
    midiIn.setSysexCallback((sysexData) => {
        println(`Sysex received ${sysexData} midiChannelSetting: ${midiChannelSetting.getRaw()}`);
        if (!sysexData.startsWith("f0002032")) {
            return;
        }
        processIncomingSysex(sysexData);
    });
    println(`${VENDOR} ${EXTENSION_NAME} controller script version ${VERSION} written by ${AUTHOR} initialized. This script comes under GPLv3 license.`);
}
function exit() {
    for (let i = 0; i < NUM_FADERS; i++) {
        displayedVolumeChanged(i, "-80");
    }
}
function flush() { }

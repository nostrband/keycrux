export const KIND_PROFILE = 0;
export const KIND_NOTE = 1;
export const KIND_CONTACTS = 3;

export const KIND_RELAYS = 10002;

export const KIND_NIP46 = 24133;

// instance event plus certificate from the enclave
export const KIND_INSTANCE = 63793;
export const KIND_BUILD = 63794;

// build and instance signatures (should we rename to "certificates")?
export const KIND_BUILD_SIGNATURE = 63795;
export const KIND_INSTANCE_SIGNATURE = 63796;

// enclaved container + certificate
export const KIND_ENCLAVED_PROCESS = 63797;

export const KIND_ROOT_CERTIFICATE = 23793;
export const KIND_ENCLAVED_CERTIFICATE = 23797;

export const KIND_ENCLAVED_PRODUCT = 63790;
export const KIND_ENCLAVED_RELEASE = 63791;
export const KIND_ENCLAVED_RELEASE_SIGNATURE = 63792;

export const CERT_TTL = 3 * 3600; // 3h

export const KIND_KEY_RPC = 29525;

export const REPO = "https://github.com/nostrband/keycrux";
export const APP_NAME = "keycrux";
export const ANNOUNCEMENT_INTERVAL = 3600000; // 1h

export const KEYCRUX_RELAY = "wss://relay.enclaved.org";

export const MAX_DATA_LENGTH = 1024;
export const DATA_TTL = 72 * 3600;
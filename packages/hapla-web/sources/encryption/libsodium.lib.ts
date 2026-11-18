// Hapla is Web-first. Keep the default resolver on the same audited JS/WASM
// implementation as `.web.ts` instead of installing a native-only binary.
import sodium from 'libsodium-wrappers';
export default sodium;

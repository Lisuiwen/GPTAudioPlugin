// The Runware media adapter uses Buffer when transforming file inputs.
// Inject the browser implementation when bundling the Sites Worker.
export { Buffer } from "buffer";

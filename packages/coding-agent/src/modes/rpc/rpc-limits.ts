/** Maximum UTF-8 size of one newline-delimited RPC frame, including the newline. */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
/** Maximum UTF-8 size of one logical frame reassembled by protocol v2. */
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;

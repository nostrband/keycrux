# Keycrux: key storage for enclaved services

Services running inside AWS Nitro Enclaves need to store keys to be able to recover state after reboot, and to facilitate code upgrades.

`keycrux` is the key store enabling that. Your enclaved service can send its keys into `keycrux` along with its `attestation` and an `upgrade policy`. When rebooted, your enclaved service can read back the keys, because the `attestation` is identical. When upgraded, your enclaved service can read back the keys if the new `attestation` matches the key's `upgrade policy`.

The `keycrux` service is stateless, make sure to store your keys in several key stores to ensure redundancy. The keys are stored for a limited time (72 hours atm), so long downtimes aren't supported yet.

## Discovery

`keycrux` instances can be discovered on Nostr (start with `wss://relay.enclaved.org`) as `kind:63793` events with `r` tag equal to `https://github.com/nostrband/keycrux`. Those will include `tee_root` tags with AWS Nitro Enclave attestation. The `relay` tag will include the inbox relay which can be used to send requests to the service. You can use [`nostr-enclaved`](https://github.com/nostrband/nostr-enclaves) library to validate the attestations of `keycrux` services:

```js
export async function validateKeycrux(e: Event) {
  const validator = new Validator({
    expectedRelease: {
      ref: "https://github.com/nostrband/keycrux",
      signerPubkeys: [<maintainer pubkeys, see below>],
    },
  });
  try {
    return await validator.validateInstance(e);
  } catch (err) {
    console.log("Invalid attestation of ", e.pubkey, e.id);
    return false;
  }
}
```

## API

After discovering the `pubkey` and `relay` of the `keycrux` service you can send requests as `kind:29525` ephemeral events, with one `p-tag` containing the service `pubkey`. The request body is a JSON string [nip44](https://github.com/nostr-protocol/nips/blob/master/44.md)-encrypted for the `pubkey`. Full structure:

```
{
  "id": <event id>,
  "pubkey": <client pubkey>,
  "created_at": <timestamp>,
  "kind": 29525,
  "tags": [
    ["p", <keycrux pubkey>]
  ],
  "content": nip44.encrypt(<keycrux pubkey>, JSON.stringify({
    "id": "<random-request-id>",
    "method": <method-name>,
    "params": {
      "attestation": <base64-encoded attestation linked to client pubkey>,
      ...<other params>
    }
  }))
}
```

The `attestation` param must have `public_key` field equal to `client pubkey`, to make sure the attestation wasn't just copied by the client from a third-party, you can use `nostr-enclaved` library to validate the attestation (`Validator.parseValidateAttestation(attestation, pubkey)`).

Results are encrypted back to the client's `pubkey` and `p`-tagging it, structure:
```
{
  "id": <event id>,
  "pubkey": <keycrux pubkey>,
  "created_at": <timestamp>,
  "kind": 29525,
  "tags": [
    ["p", <client pubkey>]
  ],
  "content": nip44.encrypt(<client pubkey>, JSON.stringify({
    "id": "<request-id>",
    "result": <any>,
    "error": <string | undefined>
  }))
}
```

### Methods

#### `set` - store the secret

Parameters:
- `attestation` - base64-encoded attestation by AWS Nitro enclave, with `public_key` field matching the `pubkey` of the request
- `data` - arbitrary string up to 1024 bytes in size (your secrets to be stored)
- `policy` - optional, `update policy` restricting the key access
- `policy.ref` - required, usually a canonical reference to the source code (i.e. github repo url)
- `policy.release_pubkeys` - optional, array of pubkeys that must sign the new PCR values that will be allowed to access this secret 
- `input` - required if `policy` is provided, provides additional metadata to make sure the current request matches the policy
- `input.ref` - required, must match the `policy.ref`
- `input.release_signatures`- optional, array of `kind:63792` Nostr events that sign PCR values from the `attestation`

Result: `ok` string if the secret was stored

Description: 

The `attestation` parameter is parsed and validated and `PCR[0,1,2,4]` values are stored along with the `data` secret. 

When `get` requests are sent, their `attestation` is parsed and if all PCR values are identical (0, 1 and 2 specify the code image and 4 specifies the EC2 instance) then the secret is returned. This handles the simple case of enclave reboot without code upgrades.

If `policy` is provided to `set` then it's stored along with the `data` secret, and when `get` is received, all keys with matching `PCR4` hashes (same EC2-instance) are selected and the `get` request is checked against their `policy` rules. At the very least, the `policy.ref` field of the secret and `input.ref` of the request must match - this can be used to differentiate btw several enclaves on the same EC2-instance, or can be used as a secret token for closed-source apps. If `policy.release_pubkeys` are provided then `input.release_signatures` must include `kind:63792` events signing the new `PCR[0,1,2]` values. This way, when code is upgraded, each maintainer creates `kind:63792` event with the same `ref` and the new `PCR[0,1,2]` values, and those are supplied into the new enclave so that it could ask for its keys from `keycrux`.

If `policy` is provided, client must include `input` that matches the policy, this makes sure that maintainers of the `set`-ting code have approved the passing of this key to the code with the same `ref` that they might release in the future.

#### `get` - get the secret

Parameters:
- `attestation` - base64-encoded attestation by AWS Nitro enclave, with `public_key` field matching the `pubkey` of the request
- `input` - required if `policy` is expected on the key, provides proof that this request matches the policy
- `input.ref` - required, must match the `policy.ref` of the stored key
- `input.release_signatures`- optional, array of `kind:63792` Nostr events that sign PCR values from the `attestation`

Result: `data` string if the secret is found, `error="Not found"` if no secret, other errors on validation failures 

Description: 

The `attestation` parameter is parsed and validated. If there is a stored key with identical `PCR[0,1,2,4]` values (0, 1 and 2 specify the code image and 4 specifies the EC2 instance) then the secret is returned. This handles the simple case of enclave reboot without code upgrades.

If no fully-matching PCR values are found then all keys with matching `PCR4` hashes (same EC2-instance) are selected and the `input` field is checked against each stored key's `policy` rules. At the very least, the `policy.ref` field of the secret and `input.ref` of the request must match - this can be used to differentiate btw several enclaves on the same EC2-instance, or can be used as a secret token for closed-source apps. If `policy.release_pubkeys` are provided then `input.release_signatures` must include `kind:63792` events signing the request's `PCR[0,1,2]` values. This way, when code is upgraded, each maintainer creates `kind:63792` event with the same `ref` and the new `PCR[0,1,2]` values, and those are supplied into the new enclave so that it could ask for its keys from `keycrux`.

### Release signatures

The `input.release_signature` field is an array of `kind:63792` events, one for each maintainer that are required by `policy.release_pubkeys`. Structure:

```
{
  "id": <event id>,
  "pubkey": <maintainer pubkey>,
  "created_at": <timestamp>,
  "kind": 63792,
  "tags": [
    ["r", <ref value that matches policy.ref>],
    ["PCR0", <PCR0 of the new enclave image>],
    ["PCR1", <PCR1 of the new enclave image>],
    ["PCR2", <PCR2 of the new enclave image>]
  ],
}
```

## Release signers

The releases of `keycrux` are signed by `3356de61b39647931ce8b2140b2bab837e0810c0ef515bbe92de0248040b8bdd` (brugeman), if you're interested in becoming a co-signer - send DMs.

## Contribution

This is an early prototype, your feedback and contributions are welcome!
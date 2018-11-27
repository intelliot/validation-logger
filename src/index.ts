import * as WebSocket from 'ws'
import * as moment from 'moment'
import * as request from 'request-promise-native'
import * as addressCodec from 'ripple-address-codec'
import * as codec from 'ripple-binary-codec'
import * as dns from 'dns'

// TODO
//const names = require('./validator-names.json')

// TODO: try using *this.*ws

// The validations stream sends messages whenever it receives validation messages,
// also called validation votes, from validators it trusts.
export interface ValidationMessage {

  // The value `validationReceived` indicates this is from the validations stream.
  type: 'validationReceived'

  // (May be omitted) The amendments this server wants to be added to the protocol.
  amendments?: string[]

  // (May be omitted) The unscaled transaction cost (`reference_fee` value) this
  // server wants to set by Fee Voting.
  base_fee?: number // Integer

  // Bit-mask of flags added to this validation message.
  // The flag 0x80000000 indicates that the validation signature is fully-canonical.
  // The flag 0x00000001 indicates that this is a full validation; otherwise it's a partial validation.
  // Partial validations are not meant to vote for any particular ledger.
  // A partial validation indicates that the validator is still online but not keeping up with consensus.
  flags: number

  // If true, this is a full validation. Otherwise, this is a partial validation.
  // Partial validations are not meant to vote for any particular ledger.
  // A partial validation indicates that the validator is still online but not keeping up with consensus.
  full: boolean

  // The identifying hash of the proposed ledger is being validated.
  ledger_hash: string

  // The Ledger Index of the proposed ledger.
  ledger_index: string // Integer

  // (May be omitted) The local load-scaled transaction cost this validator is
  // currently enforcing, in fee units.
  load_fee: number // Integer

  // (May be omitted) The minimum reserve requirement (`account_reserve` value)
  // this validator wants to set by Fee Voting.
  reserve_base: number // Integer

  // (May be omitted) The increment in the reserve requirement (`owner_reserve` value) this validator wants to set by Fee Voting.
  reserve_inc: number // Integer

  // The signature that the validator used to sign its vote for this ledger.
  signature: string

  // When this validation vote was signed, in seconds since the Ripple Epoch.
  signing_time: number
  
  // The base58 encoded public key from the key-pair that the validator used to sign the message.
  // This identifies the validator sending the message and can also be used to verify the signature.
  // Typically this is a signing key (signing_key). Use manifests to map this to an actual validation_public_key.
  validation_public_key: string

  // The time when the validation message was received.
  timestamp: moment.Moment
}

// Associates a signing_key with a master_key (pubkey).
export interface ManifestMessage {

  // The value `manifestReceived` indicates this is from the manifests stream.
  type: 'manifestReceived'

  // The base58 encoded NodePublic master key.
  master_key: string

  // The base58 encoded NodePublic signing key.
  signing_key: string

  // The sequence number of the manifest.
  seq: number // UInt

  // The signature, in hex, of the manifest.
  signature: string

  // The master signature, in hex, of the manifest.
  master_signature: string
}

// The manifest for a validator in a validator list.
export interface Manifest {
  // The hex encoded signing key (analogous to `signing_key` but in hex)
  SigningPubKey: string

  // The sequence number of the manifest (analogous to `seq`)
  Sequence: number
}

interface ValidationStreamOptions {
  address: string,
  onValidationReceived: (validationMessage: ValidationMessage) => void,
  onManifestReceived: (manifestMessage: ManifestMessage) => void,
  onClose: (cause: Error|{code: number, reason: string}) => void,
  useHeartbeat?: boolean,
  serverPingInterval?: number,
  latency?: number
}

class ValidationStream {
  readonly ws: WebSocket
  pingTimeout: NodeJS.Timer

  constructor({
    address,
    onValidationReceived,
    onManifestReceived,
    onClose,
    useHeartbeat = true,
    serverPingInterval = 30000,
    latency = 1000
  } : ValidationStreamOptions) {
    this.ws = new WebSocket(address)

    if (useHeartbeat) {
      const heartbeat = () => {
        clearTimeout(this.pingTimeout)

        // Use `WebSocket#terminate()` and not `WebSocket#close()`. Delay should be
        // equal to the interval at which your server sends out pings plus a
        // conservative assumption of the latency.
        this.pingTimeout = setTimeout(() => {
          console.error(`[${address}] WARNING: No heartbeat in ${serverPingInterval + latency} ms. Terminating...`)
          this.ws.terminate()
          onClose(new Error('Terminated due to lack of heartbeat'))
        }, serverPingInterval + latency)
      }
      
      this.ws.on('open', heartbeat)
      this.ws.on('ping', heartbeat)
      this.ws.on('close', (code: number, reason: string) => {
        clearTimeout(this.pingTimeout)
        onClose({code, reason})
      })
    }

    // You always get a 'close' event after an 'error' event.
    this.ws.on('error', (error: Error) => {
      console.error(`[${address}] ERROR: ${error}`)
    })
  
    // If the connection was closed abnormally (with an error), or if the close
    // control frame was malformed or not received then the close code must be
    // 1006.
    this.ws.on('close', (code: number, reason: string) => {
      onClose({code, reason})
    })
  
    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({
        id: 1,
        command: 'subscribe',
        streams: ['validations']
      }), () => {
        console.info(`[${address}] Subscribing to 'manifests' stream...`)
        this.ws.send(JSON.stringify({
          id: 2,
          command: 'subscribe',
          streams: ['manifests']
        }))
      })
    })
  
    this.ws.on('message', (data: string|Buffer|ArrayBuffer|Buffer[]) => {
      const dataObj = JSON.parse(data as string)

      if (dataObj.type === 'validationReceived') {
        const validationMessage: ValidationMessage = dataObj
        validationMessage.timestamp = moment()
        onValidationReceived(validationMessage)
      } else if (dataObj.type === 'manifestReceived') {
        const manifestMessage: ManifestMessage = dataObj
        onManifestReceived(manifestMessage)
      } else if (dataObj.error === 'unknownStream') {
        // One or more the members of the `streams` field of the request is not a valid stream name.

        console.error(`[${address}] WARNING: 'unknownStream' message received. Terminating...`)
        this.ws.terminate()
        onClose(new Error('Terminated due "unknownStream" message'))
      } else {
        console.error(`[${address}] WARNING: Unexpected message: ${data}`)
      }
    })
  }

  readyState() {
    switch(this.ws.readyState) {
      case 0: {
        return {
          state: 'CONNECTING',
          value: this.ws.readyState,
          description: 'The connection is not yet open.'
        }
      }
      case 1: {
        return {
          state: 'OPEN',
          value: this.ws.readyState,
          description: 'The connection is open and ready to communicate.'
        }
      }
      case 2: {
        return {
          state: 'CLOSING',
          value: this.ws.readyState,
          description: 'The connection is in the process of closing.'
        }
      }
      case 3: {
        return {
          state: 'CLOSED',
          value: this.ws.readyState,
          description: 'The connection is closed.'
        }
      }
      default: {
        return {
          state: 'UNKNOWN',
          value: this.ws.readyState,
          description: 'The connection is in an unrecognized state.'
        }
      }
    }
  }
}

/**
 * Utility methods
 */

function toBytes(hex) {
  return new Buffer(hex, 'hex').toJSON().data
}

function hexToBase58(hex) {
  return addressCodec.encodeNodePublic(toBytes(hex))
}

function remove(array, element) {
  const index = array.indexOf(element)
  if (index !== -1) {
    array.splice(index, 1)
  }
}

export type NetworkType = 'ALTNET'|'MAINNET'
export type OnUnlDataCallback = (data: {
  isDuringStartup: boolean
  isNewValidator: boolean
  isNewManifest: boolean
  validatorName: string
  validation_public_key_base58: string
  signing_key: string
  Sequence: number
  isFromManifestsStream?: boolean
}) => void

class Network {
  network: NetworkType

  static readonly WS_PORT = '51233'

  validationStreams: {
    // key: The address of the validator ('ws://' + ip + ':' + WS_PORT).
    [key: string]: ValidationStream
  }

  lastValidatorListSequence: number = 0
  validators: {
    // key: The public key of the validator, in base58 (validation_public_key_base58).
    [key: string]: {
      // The base58 encoded NodePublic signing key.
      // Also known as the SigningPubKey (hex), but in base58.
      signing_key: string

      // The sequence number of the latest manifest that informed us about this validator.
      Sequence: number // UInt
    }
  } = {}
  names: {
    // key: The public key of the validator, in base58 (validation_public_key_base58).
    // value: The name (typically the domain name) of the validator.
    [key: string]: string
  } = {}

  // Mapping of validator signing keys to pubkeys (validation_public_key_base58).
  // Used to get the actual `validation_public_key` from the `validation_public_key` (signing key) in the ValidationMessage.
  manifestKeys: {
    // key: The signing_key of the validator (SigningPubKey but in base58).
    // value: The public key of the validator, in base58 (validation_public_key_base58).
    [key: string]: string
  } = {}

  onUnlData: OnUnlDataCallback
  onValidationReceived: (validationMessage: ValidationMessage) => void

  constructor(options: {
    network: NetworkType
    onUnlData: OnUnlDataCallback
    onValidationReceived: (validationMessage: ValidationMessage) => void
  }) {
    this.network = options.network
    this.onUnlData = options.onUnlData
    this.onValidationReceived = options.onValidationReceived

    function refreshSubscriptions() {
      console.info(`[${this.network}] Refreshing subscriptions...`)
      this.getUNL()
      this.subscribeToRippleds()
    }
    
    // refresh connections
    // every minute
    setInterval(refreshSubscriptions, 60 * 1000)
    refreshSubscriptions()
  }

  subscribeToRippleds() {

    const onManifestReceived = async ({
      master_key,
      seq,
      signing_key
    }: ManifestMessage) => {
      // master_key === validation_public_key_base58
      if (this.validators[master_key] && this.validators[master_key].Sequence < seq) {
        // Delete old signing_key from manifestKeys
        delete this.manifestKeys[this.validators[master_key].signing_key]

        // Set new signing_key
        this.validators[master_key].signing_key = signing_key

        // Set new Sequence
        this.validators[master_key].Sequence = seq
        
        // Add new signing_key to manifestKeys
        this.manifestKeys[signing_key] = master_key

        // Call onUnlData callback with new data
        this.onUnlData({
          isDuringStartup: false,
          isNewValidator: false,
          isNewManifest: true,
          validatorName: await this.fetchName(master_key),
          validation_public_key_base58: master_key,
          signing_key,
          Sequence: seq,
          isFromManifestsStream: true
        })
      }
    }

    const onCloseAddress = (address: string, cause: Error|{code: number, reason: string}) => {
      if (this.validationStreams[address].readyState().state === 'OPEN') {
        console.error(`[${this.network}] [${address}] onClose: UNEXPECTED readyState(): 'OPEN'`)
      } else {
        console.info(`[${this.network}] [${address}] onClose: readyState(): '${this.validationStreams[address].readyState().state}'`)
      }
      console.error(`[${this.network}] [${address}] onClose: Error/reason: ${JSON.stringify(cause, Object.getOwnPropertyNames(cause))}. Deleting...`)
      delete this.validationStreams[address]
    }

    const hostname = this.network === 'ALTNET' ? 'r.altnet.rippletest.net' : 'r.ripple.com'
    dns.resolve4(hostname, (err, ips) => {
      if (err) {
        console.error(`[${this.network}] ERROR: ${err} (Failed to resolve ${hostname})`)
        return
      }
      for (const ip of ips) {
        const address = 'ws://' + ip + ':' + Network.WS_PORT
        if (!this.validationStreams[address]) {
          this.validationStreams[address] = new ValidationStream({
            address,
            onValidationReceived: this.onValidationReceived,
            onManifestReceived,
            onClose: (cause: Error|{code: number, reason: string}) => { onCloseAddress(address, cause) }
          })
        }
      }
    })
  }

  // getName(validation_public_key_base58: string) {
  //   return this.names[validation_public_key_base58] ? this.names[validation_public_key_base58] : validation_public_key_base58
  // }

  // setName(validation_public_key_base58: string): Promise<string> {
  //   return request.get({
  //     url: 'https://data.ripple.com/v2/network/validators/' + validation_public_key_base58,
  //     json: true
  //   }).then(data => {
  //     if (data.domain) {
  //       this.names[validation_public_key_base58] = data.domain
  //     }
  //     return this.getName(validation_public_key_base58)
  //   }).catch(() => {
  //     // request failed
  //     return this.getName(validation_public_key_base58)
  //   })
  // }

  async fetchName(validation_public_key_base58: string): Promise<string> {
    if (!this.names[validation_public_key_base58]) {
      console.info(`[${this.network}] Attempting to retrieve name of ${validation_public_key_base58} from the Data API...`)
      return request.get({
        url: 'https://data.ripple.com/v2/network/validators/' + validation_public_key_base58,
        json: true
      }).then(data => {
        if (data.domain) {
          console.info(`[${this.network}] Retrieved name: ${data.domain} (${validation_public_key_base58})`)
          this.names[validation_public_key_base58] = data.domain
          return this.names[validation_public_key_base58]
        }
        return validation_public_key_base58
      }).catch(() => {
        // request failed
        return validation_public_key_base58
      })
    }
    return this.names[validation_public_key_base58]
  }

  getUNL() {
    const validatorListUrl = this.network === 'ALTNET' ? 'https://vl.altnet.rippletest.net' : 'https://vl.ripple.com'

    request.get({
      url: validatorListUrl,
      json: true
    }).then(async (data) => {
      const buffer = new Buffer(data.blob, 'base64')
      const validatorList = JSON.parse(buffer.toString('ascii'))
      if (validatorList.sequence <= this.lastValidatorListSequence) {
        // Nothing new here...
        return
      }
      this.lastValidatorListSequence = validatorList.sequence
      const validatorsToDelete = Object.keys(this.validators)
      const isDuringStartup = (validatorsToDelete.length === 0)
      for (const validator of validatorList.validators) {
        const validation_public_key_base58 = hexToBase58(validator.validation_public_key)
        remove(validatorsToDelete, validation_public_key_base58)

        const manifestBuffer = new Buffer(validator.manifest, 'base64')
        const manifestHex = manifestBuffer.toString('hex').toUpperCase()
        const manifest = codec.decode(manifestHex)
        if (!this.validators[validation_public_key_base58] ||
            this.validators[validation_public_key_base58].Sequence < manifest.Sequence) {
          let isNewValidator = false
          let isNewManifest = false
          const signing_key = hexToBase58(manifest.SigningPubKey)
          const Sequence = manifest.Sequence
          if (this.validators[validation_public_key_base58]) {
            this.validators[validation_public_key_base58].signing_key = signing_key
            this.validators[validation_public_key_base58].Sequence = Sequence
            isNewManifest = true
          } else {
            this.validators[validation_public_key_base58] = {
              signing_key,
              Sequence
            }
            isNewValidator = true
            isNewManifest = true // always
          }
          // TODO: Verify `await` behavior
          const validatorName = await this.fetchName(validation_public_key_base58)
          this.onUnlData({
            isDuringStartup,
            isNewValidator,
            isNewManifest,
            validatorName,
            validation_public_key_base58,
            signing_key,
            Sequence
          })
          this.manifestKeys[signing_key] = validation_public_key_base58
        }
      } // for (const validator of validatorList.validators)
      for (const validator of validatorsToDelete) {
        delete this.validators[validator]
      }
      console.info(`[${this.network}] getUNL: Now have ${Object.keys(this.validators).length} validators and ${this.manifestKeys.length} manifestKeys`)
    })
  }
}

/**
 * Test App
 */

function onUnlData(data) {
  // {
  //   isDuringStartup,
  //   isNewValidator,
  //   isNewManifest,
  //   validatorName,
  //   validation_public_key_base58,
  //   signing_key,
  //   Sequence,
  //   isFromManifestsStream = false
  // }
  console.log('onUnlData', JSON.stringify(data, null, 2))
}

function onValidationReceived(validationMessage: ValidationMessage) {
  console.log('onValidationReceived', JSON.stringify(validationMessage, null, 2))
}

new Network({
  network: 'MAINNET',
  onUnlData,
  onValidationReceived
})

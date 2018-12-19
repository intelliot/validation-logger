require('source-map-support').install()
process.on('unhandledRejection', console.log)

import {Network, ValidationMessage, Logger} from '.'

/**
 * Example App
 */

let unlData = ''

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
  // console.log('onUnlData', JSON.stringify(data))
  unlData += JSON.stringify(data) + '\n'
}

let validationMessages = ''

function onValidationReceived(validationMessage: ValidationMessage) {
  // console.log('onValidationReceived', JSON.stringify(validationMessage))
  validationMessages += JSON.stringify(validationMessage) + '\n'
}

const network = new Network({
  network: 'MAINNET',
  // onUnlData,
  // onValidationReceived,
  verbose: true
})
network.onUnlData = onUnlData
network.onValidationReceived = onValidationReceived
network.connect()

const logger = new Logger({logsSubdirectory: 'MAINNET'})

setInterval(async () => {
  await logger.append('unl-data.log', unlData)
  unlData = ''
  const compressedData = await logger.compress(validationMessages)
  const filename = 'validations-' + Date.now() + '.gz.b64'
  await logger.append(filename, compressedData)
  validationMessages = ''
  console.log(`Successfully wrote "unl-data.log" and "${filename}"`)
}, 1000 * 60 * 10 /* every ten minutes */)

console.log('Started example logger')

import prismarineAuth from 'prismarine-auth'

// Source: minecraft-protocol 1.68.0, validateOptions in microsoftAuth.js.
// https://github.com/PrismarineJS/node-minecraft-protocol/blob/2ba67550867179f15bc0530a48ab56b8a5dabd9f/src/client/microsoftAuth.js#L7-L16
// Use its Microsoft device-flow defaults so authorize and the game client share a cache.
export const microsoftOptions = {
  authTitle: prismarineAuth.Titles.MinecraftNintendoSwitch,
  deviceType: 'Nintendo',
  flow: 'live'
}

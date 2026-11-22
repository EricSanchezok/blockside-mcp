import prismarineAuth from 'prismarine-auth'

// Match minecraft-protocol's Microsoft Java device flow for the same cache.
export const microsoftOptions = {
  authTitle: prismarineAuth.Titles.MinecraftNintendoSwitch,
  deviceType: 'Nintendo',
  flow: 'live'
}

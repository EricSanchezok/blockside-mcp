export const collectibleBlocks = ['dirt', 'oak_log']
export const collectCountLimit = 3
export const collectRadiusLimit = 8

const recipes = new Map([
  ['oak_planks', { ingredient: 'oak_log', inputPerBatch: 1, outputPerBatch: 4 }]
])

export const craftableItems = [...recipes.keys()]
export const craftCountLimit = 12

export function planCraft(item, count) {
  const recipe = recipes.get(item)
  if (!recipe || !Number.isInteger(count) || count < 1 || count > craftCountLimit || count % recipe.outputPerBatch !== 0) {
    return null
  }
  return { ...recipe, batches: count / recipe.outputPerBatch }
}

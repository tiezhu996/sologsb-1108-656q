import { defineStore } from 'pinia'
import { db, plain } from '../utils/db'
import type { StockSolution } from '../types/stock-solution'

type NewStock = Omit<StockSolution, 'id' | 'schemaRev'>

export function isStockExpired(expireDate: string, now = new Date()): boolean {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return new Date(`${expireDate}T23:59:59`) < today
}

export const useStockStore = defineStore('stock', {
  state: () => ({
    stocks: [] as StockSolution[],
    loading: false
  }),
  getters: {
    usableStocks: (state) => state.stocks.filter(
      (stock) => !isStockExpired(stock.expireDate) && stock.volumeMl > 0
    ),
    totalStockVolume: (state) => state.stocks.reduce((sum, stock) => sum + stock.volumeMl, 0)
  },
  actions: {
    async load(): Promise<void> {
      this.loading = true
      try {
        this.stocks = await db.stockSolutions.orderBy('id').reverse().toArray()
      } finally {
        this.loading = false
      }
    },
    async addStock(payload: NewStock): Promise<number> {
      const id = await db.stockSolutions.add(plain({ ...payload, schemaRev: 3 }))
      await this.load()
      return id
    },
    async deleteStock(id: number): Promise<void> {
      await db.stockSolutions.delete(id)
      await this.load()
    }
  }
})

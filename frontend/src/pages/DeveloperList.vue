<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import DilutionInput from '../components/common/DilutionInput.vue'
import StatBadge from '../components/common/StatBadge.vue'
import EmptyPanel from '../components/common/EmptyPanel.vue'
import { useDeveloperStore } from '../stores/developerStore'
import { useStockStore, isStockExpired } from '../stores/stockStore'
import { usePreparationStore } from '../stores/preparationStore'
import type { Developer, DeveloperCategory, DeveloperState, Dilution } from '../types/developer'
import type { StockSolution } from '../types/stock-solution'
import { calculateStockVolume, remainingRolls } from '../utils/ratio'

type TabKey = 'developers' | 'stocks' | 'preparations'

interface PrepareForm {
  name: string
  category: DeveloperCategory
  stockSolutionId: number | undefined
  dilution: Dilution
  volumeMl: number
  maxRolls: number
}

interface StockForm {
  name: string
  category: DeveloperCategory
  openedAt: string
  expireDate: string
  volumeMl: number
}

const developerStore = useDeveloperStore()
const stockStore = useStockStore()
const preparationStore = usePreparationStore()

const activeTab = ref<TabKey>('developers')
const showPrepareForm = ref(false)
const showStockForm = ref(false)
const saving = ref(false)

const today = new Date().toISOString().slice(0, 10)

const prepareForm = reactive<PrepareForm>({
  name: '',
  category: 'D-76',
  stockSolutionId: undefined,
  dilution: '1:1',
  volumeMl: 1000,
  maxRolls: 12
})

const stockForm = reactive<StockForm>({
  name: '',
  category: 'D-76',
  openedAt: today,
  expireDate: '',
  volumeMl: 500
})

const tabs = computed(() => [
  { key: 'developers' as TabKey, label: '工作液', count: developerStore.developers.length },
  { key: 'stocks' as TabKey, label: '母液台账', count: stockStore.stocks.length },
  { key: 'preparations' as TabKey, label: '配制记录', count: preparationStore.preparations.length }
])

const requiredStockVolume = computed(() =>
  calculateStockVolume(prepareForm.volumeMl, prepareForm.dilution)
)

const selectedStock = computed(() =>
  stockStore.stocks.find((stock) => stock.id === prepareForm.stockSolutionId)
)

watch(() => stockForm.openedAt, (openedAt) => {
  if (!openedAt) return
  const date = new Date(`${openedAt}T00:00:00`)
  date.setDate(date.getDate() + 180)
  stockForm.expireDate = date.toISOString().slice(0, 10)
})

function stateTone(developer: Developer): 'cyan' | 'amber' | 'rose' | 'muted' {
  if (developer.state === '报废') return 'rose'
  if (developer.state === '已撤销') return 'muted'
  if (developer.state === '新配') return 'cyan'
  return 'amber'
}

function stockState(stock: StockSolution): { label: string; className: string } {
  if (stock.volumeMl <= 0) return { label: '已用完', className: 'status--muted' }
  if (isStockExpired(stock.expireDate)) return { label: '已过期', className: 'status--danger' }
  const soon = new Date()
  soon.setMonth(soon.getMonth() + 1)
  if (new Date(`${stock.expireDate}T23:59:59`) <= soon) return { label: '临期', className: 'status--warning' }
  return { label: '有效', className: 'status--ok' }
}

function stockName(stockSolutionId?: number): string {
  if (stockSolutionId === undefined) return '—'
  return stockStore.stocks.find((stock) => stock.id === stockSolutionId)?.name ?? '母液已删除'
}

async function submitStock(): Promise<void> {
  if (!stockForm.name.trim() || !stockForm.openedAt || !stockForm.expireDate) {
    ElMessage.warning('请填写母液名称、开封日与有效期')
    return
  }
  saving.value = true
  try {
    await stockStore.addStock({
      name: stockForm.name.trim(),
      category: stockForm.category,
      openedAt: stockForm.openedAt,
      expireDate: stockForm.expireDate,
      volumeMl: Math.max(0, stockForm.volumeMl)
    })
    ElMessage.success('母液已登记入账')
    stockForm.name = ''
    stockForm.volumeMl = 500
    showStockForm.value = false
  } finally {
    saving.value = false
  }
}

async function submitPrepare(): Promise<void> {
  if (!prepareForm.name.trim()) {
    ElMessage.warning('请填写工作液名称')
    return
  }
  if (prepareForm.stockSolutionId === undefined) {
    ElMessage.warning('请选择用于配制的母液')
    return
  }
  if (prepareForm.volumeMl <= 0) {
    ElMessage.warning('目标容量必须大于 0')
    return
  }
  saving.value = true
  try {
    await preparationStore.prepare({
      stockSolutionId: prepareForm.stockSolutionId,
      category: prepareForm.category,
      name: prepareForm.name.trim(),
      dilution: prepareForm.dilution,
      targetVolumeMl: Math.max(1, prepareForm.volumeMl),
      maxRolls: Math.max(1, prepareForm.maxRolls)
    })
    ElMessage.success('工作液已配制，母液余量已扣减')
    prepareForm.name = ''
    prepareForm.volumeMl = 1000
    prepareForm.maxRolls = 12
    showPrepareForm.value = false
    await Promise.all([developerStore.load(), stockStore.load(), preparationStore.load()])
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '配制失败，已回滚，未写入任何数据')
  } finally {
    saving.value = false
  }
}

async function revokeDeveloper(developer: Developer): Promise<void> {
  if (developer.id === undefined) return
  try {
    await preparationStore.revoke(developer.id)
    ElMessage.success('已撤销配制，母液余量已恢复')
    await Promise.all([developerStore.load(), stockStore.load(), preparationStore.load()])
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '撤销失败，已回滚')
  }
}

async function scrapDeveloper(id?: number): Promise<void> {
  if (id === undefined) return
  await developerStore.scrap(id)
  ElMessage.success('该工作液已标记为报废')
}

async function removeStock(id?: number): Promise<void> {
  if (id === undefined) return
  await stockStore.deleteStock(id)
  ElMessage.success('母液记录已删除')
}

function togglePrepareForm(): void {
  showPrepareForm.value = !showPrepareForm.value
  if (!showPrepareForm.value) return
  showStockForm.value = false
  if (prepareForm.stockSolutionId === undefined && stockStore.usableStocks[0]?.id !== undefined) {
    prepareForm.stockSolutionId = stockStore.usableStocks[0].id
  }
}

function toggleStockForm(): void {
  showStockForm.value = !showStockForm.value
  if (showStockForm.value) showPrepareForm.value = false
}

onMounted(async () => {
  await Promise.all([developerStore.load(), stockStore.load(), preparationStore.load()])
  if (prepareForm.stockSolutionId === undefined && stockStore.usableStocks[0]?.id !== undefined) {
    prepareForm.stockSolutionId = stockStore.usableStocks[0].id
  }
})
</script>

<template>
  <section class="page-shell">
    <header class="page-hero page-hero--compact">
      <div>
        <span class="eyebrow">CHEMISTRY DESK</span>
        <h1>显影液配制与母液台账</h1>
        <p>母液按开封日登记余量，配制工作液时自动扣减；过期、余量不足或类别不符一律拒绝写入。</p>
      </div>
      <div class="hero-actions">
        <button type="button" class="ghost-button" data-testid="new-stock" @click="toggleStockForm">
          {{ showStockForm ? '收起表单' : '登记母液' }}
        </button>
        <button type="button" class="primary-button" data-testid="new-developer" @click="togglePrepareForm">
          {{ showPrepareForm ? '收起表单' : '配制工作液' }}
        </button>
      </div>
    </header>

    <div class="stat-strip">
      <StatBadge label="工作液总数" :value="developerStore.developers.length" hint="含新配、在用、报废与已撤销" tone="cyan" />
      <StatBadge label="可用余量" :value="developerStore.availableRolls" hint="按剩余可冲卷数合计" tone="amber" />
      <StatBadge label="母液种类" :value="stockStore.stocks.length" hint="含已过期与已用完" tone="cyan" />
      <StatBadge label="母液总余量" :value="stockStore.totalStockVolume" hint="mL，未扣减过期部分" tone="amber" />
    </div>

    <form v-if="showStockForm" class="inline-form" data-testid="form-stock" @submit.prevent="submitStock">
      <div class="inline-form__head">
        <div>
          <h2>登记母液</h2>
          <p>母液按类别分别建卡，记录开封日与当前余量；有效期默认按开封后 180 天估算，可手动修改。</p>
        </div>
      </div>
      <div class="form-grid form-grid--three">
        <label>
          <span>母液名称</span>
          <input v-model="stockForm.name" data-testid="field-stock-name" type="text" placeholder="如 柯达 D-76 母液" />
        </label>
        <label>
          <span>类别</span>
          <select v-model="stockForm.category" data-testid="field-stock-category">
            <option value="D-76">D-76</option>
            <option value="HC-110">HC-110</option>
            <option value="Rodinal">Rodinal</option>
            <option value="C-41">C-41</option>
          </select>
        </label>
        <label>
          <span>余量 (mL)</span>
          <input v-model.number="stockForm.volumeMl" data-testid="field-stock-volumeMl" type="number" min="0" step="50" />
        </label>
        <label>
          <span>开封日</span>
          <input v-model="stockForm.openedAt" data-testid="field-stock-openedAt" type="date" />
        </label>
        <label>
          <span>有效期至</span>
          <input v-model="stockForm.expireDate" data-testid="field-stock-expireDate" type="date" />
        </label>
      </div>
      <div class="form-actions">
        <button type="button" class="ghost-button" @click="showStockForm = false">取消</button>
        <button type="submit" class="primary-button" data-testid="submit-stock" :disabled="saving">
          {{ saving ? '保存中…' : '登记母液' }}
        </button>
      </div>
    </form>

    <form v-if="showPrepareForm" class="inline-form" data-testid="form-developer" @submit.prevent="submitPrepare">
      <div class="inline-form__head">
        <div>
          <h2>用母液配制工作液</h2>
          <p>选择母液与稀释比，按目标容量换算母液用量并扣减；母液过期、余量不足或类别不符时拒绝写入。</p>
        </div>
      </div>
      <div class="form-grid form-grid--three">
        <label>
          <span>工作液名称</span>
          <input v-model="prepareForm.name" data-testid="field-name" type="text" placeholder="如 柯达 D-76 工作液 A" />
        </label>
        <label>
          <span>工作液类别</span>
          <select v-model="prepareForm.category" data-testid="field-category">
            <option value="D-76">D-76</option>
            <option value="HC-110">HC-110</option>
            <option value="Rodinal">Rodinal</option>
            <option value="C-41">C-41</option>
          </select>
        </label>
        <label>
          <span>母液</span>
          <select v-model="prepareForm.stockSolutionId" data-testid="field-stockSolution">
            <option v-for="stock in stockStore.stocks" :key="stock.id" :value="stock.id"
              :disabled="isStockExpired(stock.expireDate) || stock.volumeMl <= 0">
              {{ stock.name }}（{{ stock.category }} · 余 {{ stock.volumeMl }} mL{{ isStockExpired(stock.expireDate) ? ' · 已过期' : '' }}{{ stock.volumeMl <= 0 ? ' · 已用完' : '' }}）
            </option>
          </select>
        </label>
        <div class="span-2">
          <DilutionInput
            v-model:ratio="prepareForm.dilution"
            v-model:working-volume-ml="prepareForm.volumeMl"
            ratio-test-id="field-dilution"
            volume-test-id="field-volumeMl"
          />
        </div>
        <label>
          <span>可冲上限</span>
          <input v-model.number="prepareForm.maxRolls" data-testid="field-maxRolls" type="number" min="1" max="100" />
        </label>
      </div>
      <p v-if="selectedStock" class="prepare-hint" data-testid="hint-stock-deduction">
        本次需扣减母液 <strong>{{ requiredStockVolume }} mL</strong>（{{ selectedStock.name }} · 当前余 {{ selectedStock.volumeMl }} mL，扣减后余 {{ selectedStock.volumeMl - requiredStockVolume }} mL）。
      </p>
      <div class="form-actions">
        <button type="button" class="ghost-button" @click="showPrepareForm = false">取消</button>
        <button type="submit" class="primary-button" data-testid="submit-developer" :disabled="saving">
          {{ saving ? '配制中…' : '配制并扣减母液' }}
        </button>
      </div>
    </form>

    <div class="tabs" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        role="tab"
        class="tab"
        :class="{ active: activeTab === tab.key }"
        :aria-selected="activeTab === tab.key"
        data-testid="tab-button"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}<em>{{ tab.count }}</em>
      </button>
    </div>

    <div v-show="activeTab === 'developers'" class="dev-grid">
      <div class="panel dev-count-panel">
        <span>台账记录</span>
        <strong data-testid="count-developer">{{ developerStore.developers.length }}</strong>
        <small>条工作液记录</small>
      </div>
      <article
        v-for="developer in developerStore.developers"
        :key="developer.id"
        class="entity-card developer-card"
        :class="{ 'card--revoked': developer.state === '已撤销' }"
        data-testid="row-developer"
      >
        <div class="entity-card__main">
          <div class="entity-card__title">
            <div>
              <span class="status-chip" :class="`status--${stateTone(developer)}`">{{ developer.state }}</span>
              <h2>{{ developer.name }}</h2>
              <p v-if="developer.source === 'prepared'">
                母液配制 · {{ stockName(developer.stockSolutionId) }}
                <template v-if="developer.state !== '已撤销'"> · 扣减 {{ developer.stockVolumeMl }} mL</template>
              </p>
              <p v-else>来源未追溯 · 升级前已有数据，未补造母液</p>
            </div>
            <div class="card-actions">
              <button
                v-if="developer.state !== '报废' && developer.state !== '已撤销' && developer.usedRolls === 0"
                type="button"
                class="text-button"
                data-testid="revoke-developer"
                @click="revokeDeveloper(developer)"
              >
                撤销配制
              </button>
              <button
                v-if="developer.state !== '报废' && developer.state !== '已撤销'"
                type="button"
                class="text-button text-button--danger"
                @click="scrapDeveloper(developer.id)"
              >
                标记报废
              </button>
            </div>
          </div>
          <dl class="data-pairs">
            <div><dt>类型 / 稀释</dt><dd>{{ developer.category }} · {{ developer.dilution }}</dd></div>
            <div><dt>工作液容量</dt><dd>{{ developer.volumeMl }} mL</dd></div>
            <div><dt>配制日期</dt><dd>{{ developer.mixedAt }}</dd></div>
            <div><dt>所需浓缩液</dt><dd>{{ calculateStockVolume(developer.volumeMl, developer.dilution) }} mL</dd></div>
          </dl>
          <div class="life-meter">
            <div class="life-meter__head">
              <span>剩余 {{ remainingRolls(developer.maxRolls, developer.usedRolls) }} 卷</span>
              <span>已用 {{ developer.usedRolls }} / {{ developer.maxRolls }}</span>
            </div>
            <div class="life-meter__track">
              <i :style="{ width: `${Math.min(100, developer.usedRolls / developer.maxRolls * 100)}%` }"></i>
            </div>
            <small v-if="remainingRolls(developer.maxRolls, developer.usedRolls) === 0 && developer.state !== '已撤销'">余量已耗尽，建议报废并重新配制。</small>
            <small v-else-if="developer.state === '已撤销'">该工作液未冲洗即撤销，母液余量已恢复。</small>
          </div>
        </div>
      </article>
      <EmptyPanel v-if="developerStore.developers.length === 0" title="还没有工作液" description="点击右上角「配制工作液」，用母液配制第一份工作液。" />
    </div>

    <div v-show="activeTab === 'stocks'" class="dev-grid">
      <div class="panel dev-count-panel">
        <span>母液台账</span>
        <strong data-testid="count-stock">{{ stockStore.stocks.length }}</strong>
        <small>条母液记录</small>
      </div>
      <article
        v-for="stock in stockStore.stocks"
        :key="stock.id"
        class="entity-card developer-card"
        data-testid="row-stock"
      >
        <div class="entity-card__main">
          <div class="entity-card__title">
            <div>
              <span class="status-chip" :class="stockState(stock).className">{{ stockState(stock).label }}</span>
              <h2>{{ stock.name }}</h2>
              <p>{{ stock.category }} · 开封于 {{ stock.openedAt }}</p>
            </div>
            <button
              type="button"
              class="text-button text-button--danger"
              data-testid="delete-stock"
              @click="removeStock(stock.id)"
            >
              删除
            </button>
          </div>
          <dl class="data-pairs">
            <div><dt>当前余量</dt><dd :class="{ 'text-danger': stock.volumeMl <= 0 }">{{ stock.volumeMl }} mL</dd></div>
            <div><dt>开封日</dt><dd>{{ stock.openedAt }}</dd></div>
            <div><dt>有效期至</dt><dd>{{ stock.expireDate }}</dd></div>
          </dl>
        </div>
      </article>
      <EmptyPanel v-if="stockStore.stocks.length === 0" title="还没有母液记录" description="点击「登记母液」，按类别登记母液的开封日与余量。" />
    </div>

    <div v-show="activeTab === 'preparations'" class="panel">
      <div class="table-wrap">
        <table data-testid="table-preparations">
          <thead>
            <tr>
              <th>配制日期</th>
              <th>母液</th>
              <th>类别</th>
              <th>工作液</th>
              <th>稀释比</th>
              <th>目标容量</th>
              <th>扣减母液</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="preparation in preparationStore.preparations" :key="preparation.id" data-testid="row-preparation">
              <td>{{ preparation.preparedAt }}</td>
              <td>
                <strong>{{ preparation.stockName }}</strong>
                <small v-if="preparation.status === '已撤销'">{{ preparation.revokedAt ? `${preparation.revokedAt} 撤销` : '已撤销' }}</small>
              </td>
              <td>{{ preparation.category }}</td>
              <td>{{ preparation.developerName }}</td>
              <td>{{ preparation.dilution }}</td>
              <td>{{ preparation.targetVolumeMl }} mL</td>
              <td>{{ preparation.stockVolumeMl }} mL</td>
              <td>
                <span class="status-chip" :class="preparation.status === '已撤销' ? 'status--muted' : 'status--ok'">
                  {{ preparation.status }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <EmptyPanel v-if="preparationStore.preparations.length === 0" title="还没有配制记录" description="用母液配制工作液后，这里会生成一条可追溯的配制台账。" />
    </div>
  </section>
</template>

<style scoped>
.hero-actions {
  display: flex;
  gap: 10px;
}

.tabs {
  display: flex;
  gap: 8px;
  margin: 4px 0 18px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: rgba(255, 253, 248, 0.9);
}

.tab {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 8px 16px;
  border: 1px solid transparent;
  border-radius: 9px;
  color: var(--ink-soft);
  background: transparent;
  cursor: pointer;
}

.tab em {
  font-style: normal;
  font-size: 11px;
  color: var(--ink-soft);
  background: #efe6d6;
  border-radius: 999px;
  padding: 1px 8px;
}

.tab.active {
  border-color: #d9b38c;
  color: var(--accent-deep);
  background: #f7ead9;
  font-weight: 650;
}

.tab.active em {
  background: #e7d3b8;
  color: var(--accent-deep);
}

.card-actions {
  display: flex;
  gap: 12px;
  align-items: center;
}

.card--revoked {
  opacity: 0.72;
}

.prepare-hint {
  margin: 12px 0 0;
  padding: 10px 14px;
  border: 1px solid rgba(181, 102, 39, 0.25);
  border-radius: 10px;
  color: #7c5738;
  background: #fbf1e4;
  font-size: 12px;
}

.prepare-hint strong {
  color: var(--accent-deep);
  font-size: 14px;
}

.status--muted {
  color: #6f665b;
  background: #e9e2d6;
}
</style>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import DilutionInput from '../components/common/DilutionInput.vue'
import StatBadge from '../components/common/StatBadge.vue'
import { useDeveloperStore } from '../stores/developerStore'
import { useStockStore } from '../stores/stockStore'
import { MixValidationError } from '../types/stock'
import type { Developer, DeveloperCategory, DeveloperState, Dilution } from '../types/developer'
import type { MixRecord } from '../types/stock'
import { calculateStockVolume, remainingRolls } from '../utils/ratio'
import { addDays, daysUntilExpire, isExpired, STOCK_SHELF_LIFE_DAYS, today } from '../utils/date'

type TabKey = 'stock' | 'working' | 'ledger'

interface StockForm {
  name: string
  category: DeveloperCategory
  openedAt: string
  expireDate: string
  volumeMl: number
  note: string
}

interface MixForm {
  category: DeveloperCategory
  stockId: number | ''
  workingName: string
  dilution: Dilution
  targetVolumeMl: number
  mixedAt: string
}

interface DeveloperForm {
  name: string
  category: DeveloperCategory
  dilution: Dilution
  volumeMl: number
  mixedAt: string
  maxRolls: number
  usedRolls: number
  state: DeveloperState
}

const CATEGORY_OPTIONS: DeveloperCategory[] = ['D-76', 'HC-110', 'Rodinal', 'C-41']

const developerStore = useDeveloperStore()
const stockStore = useStockStore()

const activeTab = ref<TabKey>('stock')
const tabs: Array<{ key: TabKey; label: string; testId: string }> = [
  { key: 'stock', label: '母液台账', testId: 'tab-stock' },
  { key: 'working', label: '工作液', testId: 'tab-working' },
  { key: 'ledger', label: '分装配制记录', testId: 'tab-ledger' }
]

const showStockForm = ref(false)
const savingStock = ref(false)
const stockForm = reactive<StockForm>({
  name: '',
  category: 'D-76',
  openedAt: today(),
  expireDate: addDays(today(), STOCK_SHELF_LIFE_DAYS),
  volumeMl: 500,
  note: ''
})

// 调整开封日后默认顺延 6 个月作为失效日，仍可手工修改
watch(() => stockForm.openedAt, (value) => {
  if (value) stockForm.expireDate = addDays(value, STOCK_SHELF_LIFE_DAYS)
})

async function submitStock(): Promise<void> {
  if (!stockForm.name.trim() || !stockForm.openedAt || !stockForm.expireDate) {
    ElMessage.warning('请填写母液名称、开封日期与失效日期')
    return
  }
  if (stockForm.expireDate < stockForm.openedAt) {
    ElMessage.warning('失效日期不能早于开封日期')
    return
  }
  savingStock.value = true
  try {
    await stockStore.registerStock({
      name: stockForm.name.trim(),
      category: stockForm.category,
      openedAt: stockForm.openedAt,
      expireDate: stockForm.expireDate,
      volumeMl: Math.max(0, Number(stockForm.volumeMl) || 0),
      note: stockForm.note.trim() || undefined
    })
    ElMessage.success('母液已登记入账')
    stockForm.name = ''
    stockForm.note = ''
    stockForm.volumeMl = 500
    showStockForm.value = false
  } finally {
    savingStock.value = false
  }
}

// ---------- 由母液调工作液 ----------
const showMixForm = ref(false)
const showManualForm = ref(false)
const savingMix = ref(false)
const mixForm = reactive<MixForm>({
  category: 'D-76',
  stockId: '',
  workingName: '',
  dilution: '1:1',
  targetVolumeMl: 600,
  mixedAt: today()
})

const stockOptions = computed(() => stockStore.usableStocks(mixForm.category))
const selectedMixStock = computed(() =>
  stockStore.stocks.find((stock) => stock.id === mixForm.stockId) ?? null
)
const requiredMl = computed(() =>
  mixForm.stockId === '' ? 0 : calculateStockVolume(mixForm.targetVolumeMl, mixForm.dilution)
)
const stockEnough = computed(() =>
  selectedMixStock.value ? selectedMixStock.value.volumeMl >= requiredMl.value : false
)

// 切换类别后，若原选母液不属于该类别则清空，避免类别不符
watch(() => mixForm.category, () => {
  if (mixForm.stockId !== '' && !stockOptions.value.some((stock) => stock.id === mixForm.stockId)) {
    mixForm.stockId = ''
    mixForm.workingName = ''
  }
})

watch(() => mixForm.stockId, (id) => {
  const stock = stockStore.stocks.find((item) => item.id === id)
  if (stock && !mixForm.workingName.trim()) {
    mixForm.workingName = `${stock.name.replace(/母液|浓缩液|糖浆/g, '').trim() || stock.name} 工作液`
  }
})

function openMixForm(): void {
  showManualForm.value = false
  showMixForm.value = !showMixForm.value
}

function openManualForm(): void {
  showMixForm.value = false
  showManualForm.value = !showManualForm.value
}

async function submitMix(): Promise<void> {
  if (mixForm.stockId === '') {
    ElMessage.warning('请选择一瓶母液')
    return
  }
  savingMix.value = true
  try {
    const result = await stockStore.mixWorking({
      category: mixForm.category,
      stockId: Number(mixForm.stockId),
      workingName: mixForm.workingName,
      dilution: mixForm.dilution,
      targetVolumeMl: Number(mixForm.targetVolumeMl),
      mixedAt: mixForm.mixedAt
    })
    await developerStore.load()
    ElMessage.success(`已扣减母液 ${result.stockUsedMl} mL，工作液与台账记录已生成`)
    mixForm.stockId = ''
    mixForm.workingName = ''
    mixForm.targetVolumeMl = 600
    showMixForm.value = false
  } catch (error) {
    if (error instanceof MixValidationError) {
      ElMessage.error(error.message)
    } else {
      throw error
    }
  } finally {
    savingMix.value = false
  }
}

// ---------- 手工登记工作液（来源不追溯） ----------
const savingManual = ref(false)
const manualForm = reactive<DeveloperForm>({
  name: '',
  category: 'D-76',
  dilution: '1:1',
  volumeMl: 1000,
  mixedAt: today(),
  maxRolls: 12,
  usedRolls: 0,
  state: '新配'
})

async function submitManual(): Promise<void> {
  if (!manualForm.name.trim() || !manualForm.mixedAt) {
    ElMessage.warning('请填写工作液名称与配制日期')
    return
  }
  savingManual.value = true
  try {
    await developerStore.addDeveloper({
      ...manualForm,
      name: manualForm.name.trim(),
      volumeMl: Math.max(0, manualForm.volumeMl),
      maxRolls: Math.max(1, manualForm.maxRolls),
      usedRolls: Math.max(0, manualForm.usedRolls)
    })
    ElMessage.success('工作液已登记（来源未追溯）')
    manualForm.name = ''
    manualForm.mixedAt = today()
    manualForm.maxRolls = 12
    manualForm.usedRolls = 0
    manualForm.state = '新配'
    showManualForm.value = false
  } finally {
    savingManual.value = false
  }
}

// ---------- 撤销 ----------
async function revokeMix(mix: MixRecord): Promise<void> {
  const working = developerById(mix.workingDeveloperId)
  if (working && working.usedRolls > 0) {
    ElMessage.error(`工作液「${working.name}」已冲洗 ${working.usedRolls} 卷，已冲洗的工作液不能撤销`)
    return
  }
  try {
    await ElMessageBox.confirm(
      `撤销后母液「${mix.stockName}」恢复 ${mix.stockUsedMl} mL，工作液作废，台账保留为“已撤销”。是否继续？`,
      '撤销本次配制',
      { confirmButtonText: '撤销配制', cancelButtonText: '保留', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    const result = await stockStore.revokeMix(mix.id!)
    await developerStore.load()
    ElMessage.success(`已撤销并恢复母液余量 ${result.restoredMl} mL，记录留作已撤销`)
  } catch (error) {
    if (error instanceof MixValidationError) {
      ElMessage.error(`${error.message}；母液余量未改动，记录保持原状`)
    } else {
      throw error
    }
  }
}

async function scrapDeveloper(id?: number): Promise<void> {
  if (id === undefined) return
  await developerStore.scrap(id)
  ElMessage.success('该工作液已标记为报废')
}

// ---------- 展示辅助 ----------
function developerById(id: number): Developer | undefined {
  return developerStore.developers.find((item) => item.id === id)
}

function stockById(id: number) {
  return stockStore.stocks.find((item) => item.id === id)
}

type ChipTone = 'cyan' | 'amber' | 'rose' | 'slate'

function stockTone(stock: { expireDate: string; volumeMl: number }): ChipTone {
  if (isExpired(stock.expireDate) || stock.volumeMl <= 0) return 'rose'
  if (daysUntilExpire(stock.expireDate) <= 14) return 'amber'
  return 'cyan'
}

function stockStatus(stock: { expireDate: string; volumeMl: number }): string {
  if (stock.volumeMl <= 0) return '余量耗尽'
  if (isExpired(stock.expireDate)) return '已过期'
  const days = daysUntilExpire(stock.expireDate)
  if (days <= 14) return `${days} 天后过期`
  return '在效期'
}

function stateTone(developer: Developer): ChipTone {
  if (developer.state === '报废' || developer.state === '已撤销') return 'rose'
  if (developer.state === '新配') return 'cyan'
  return 'amber'
}

function mixRowTone(mix: MixRecord): ChipTone {
  if (mix.status === '已撤销') return 'slate'
  const working = developerById(mix.workingDeveloperId)
  if (working && working.usedRolls > 0) return 'amber'
  return 'cyan'
}

function mixRowHint(mix: MixRecord): string {
  if (mix.status === '已撤销') return `已于 ${mix.revokedAt ?? '-'} 撤销`
  const working = developerById(mix.workingDeveloperId)
  if (working && working.usedRolls > 0) return `已冲洗 ${working.usedRolls} 卷，不可撤销`
  return '未冲洗，可撤销'
}

const usableStockCount = computed(() =>
  stockStore.stocks.filter((stock) => stock.volumeMl > 0 && !isExpired(stock.expireDate)).length
)
const revokedDeveloperCount = computed(
  () => developerStore.developers.filter((item) => item.state === '已撤销').length
)
const tracedCount = computed(() => developerStore.tracedDevelopers.length)

onMounted(async () => {
  await Promise.all([stockStore.load(), developerStore.load()])
})
</script>

<template>
  <section class="page-shell">
    <header class="page-hero page-hero--compact">
      <div>
        <span class="eyebrow">CHEMISTRY LEDGER</span>
        <h1>显影液分装配置台账</h1>
        <p>母液登记类别、开封日与余量；由母液调工作液时按稀释比扣减并逐笔留痕，撤销可回退余量。</p>
      </div>
    </header>

    <div class="ledger-tabs" role="tablist">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        role="tab"
        :class="['ledger-tab', { 'ledger-tab--active': activeTab === tab.key }]"
        :data-testid="tab.testId"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- ================= 母液台账 ================= -->
    <template v-if="activeTab === 'stock'">
      <div class="stat-strip">
        <StatBadge label="母液总数" :value="stockStore.stocks.length" hint="按瓶独立建账" tone="cyan" />
        <StatBadge label="可配制母液" :value="usableStockCount" hint="未过期且有余量" tone="amber" />
        <StatBadge label="已过期/耗尽" :value="stockStore.stocks.length - usableStockCount" hint="拒绝用于配制" tone="rose" />
      </div>

      <div class="ledger-toolbar">
        <button type="button" class="primary-button" data-testid="new-stock" @click="showStockForm = !showStockForm">
          {{ showStockForm ? '收起表单' : '登记母液' }}
        </button>
      </div>

      <form v-if="showStockForm" class="inline-form" data-testid="form-stock" @submit.prevent="submitStock">
        <div class="inline-form__head">
          <div>
            <h2>登记母液</h2>
            <p>记录类别、开封日期与当前余量；失效日默认按开封后 6 个月（{{ STOCK_SHELF_LIFE_DAYS }} 天）推算。</p>
          </div>
        </div>
        <div class="form-grid form-grid--three">
          <label>
            <span>母液名称</span>
            <input v-model="stockForm.name" data-testid="field-stock-name" type="text" placeholder="如 柯达 D-76 浓缩母液" />
          </label>
          <label>
            <span>类别</span>
            <select v-model="stockForm.category" data-testid="field-stock-category">
              <option v-for="option in CATEGORY_OPTIONS" :key="option" :value="option">{{ option }}</option>
            </select>
          </label>
          <label>
            <span>当前余量</span>
            <input v-model.number="stockForm.volumeMl" data-testid="field-stock-volume" type="number" min="0" step="10" />
            <em class="unit-em">mL</em>
          </label>
          <label>
            <span>开封日期</span>
            <input v-model="stockForm.openedAt" data-testid="field-stock-openedAt" type="date" />
          </label>
          <label>
            <span>失效日期</span>
            <input v-model="stockForm.expireDate" data-testid="field-stock-expireDate" type="date" />
          </label>
          <label>
            <span>备注</span>
            <input v-model="stockForm.note" data-testid="field-stock-note" type="text" placeholder="选填" />
          </label>
        </div>
        <div class="form-actions">
          <button type="button" class="ghost-button" @click="showStockForm = false">取消</button>
          <button type="submit" class="primary-button" data-testid="submit-stock" :disabled="savingStock">
            {{ savingStock ? '保存中…' : '登记入账' }}
          </button>
        </div>
      </form>

      <div class="dev-grid">
        <article
          v-for="stock in stockStore.stocks"
          :key="stock.id"
          class="entity-card developer-card"
          :class="{ 'entity-card--muted': isExpired(stock.expireDate) || stock.volumeMl <= 0 }"
          data-testid="row-stock"
        >
          <div class="entity-card__main">
            <div class="entity-card__title">
              <div>
                <span class="status-chip" :class="`status--${stockTone(stock)}`">{{ stockStatus(stock) }}</span>
                <h2>{{ stock.name }}</h2>
              </div>
            </div>
            <dl class="data-pairs">
              <div><dt>类别</dt><dd>{{ stock.category }}</dd></div>
              <div><dt>开封日期</dt><dd>{{ stock.openedAt }}</dd></div>
              <div><dt>失效日期</dt><dd>{{ stock.expireDate }}</dd></div>
              <div><dt>当前余量</dt><dd data-testid="stock-remaining">{{ stock.volumeMl }} mL</dd></div>
            </dl>
            <small v-if="stock.note" class="stock-note">{{ stock.note }}</small>
          </div>
        </article>
        <div v-if="stockStore.stocks.length === 0" class="panel inline-empty">还没有母液，先登记一瓶。</div>
      </div>
    </template>

    <!-- ================= 工作液 ================= -->
    <template v-if="activeTab === 'working'">
      <div class="stat-strip">
        <StatBadge label="工作液总数" :value="developerStore.developers.length" hint="含报废与撤销记录" tone="cyan" />
        <StatBadge label="可用余量(卷)" :value="developerStore.availableRolls" hint="按剩余可冲卷数合计" tone="amber" />
        <StatBadge label="来源可追溯" :value="tracedCount" hint="由母液分装生成" />
        <StatBadge label="已撤销" :value="revokedDeveloperCount" hint="撤销配制后作废" tone="rose" />
      </div>

      <div class="ledger-toolbar">
        <button type="button" class="primary-button" data-testid="new-mix" @click="openMixForm">
          {{ showMixForm ? '收起表单' : '由母液调工作液' }}
        </button>
        <button type="button" class="ghost-button" data-testid="new-developer" @click="openManualForm">
          {{ showManualForm ? '收起手工登记' : '手工登记工作液' }}
        </button>
      </div>

      <form v-if="showMixForm" class="inline-form" data-testid="form-mix" @submit.prevent="submitMix">
        <div class="inline-form__head">
          <div>
            <h2>由母液调工作液</h2>
            <p>选择母液、稀释比与目标容量；系统按现有换算扣减母液，并生成工作液和台账记录。</p>
          </div>
        </div>
        <div class="form-grid form-grid--three">
          <label>
            <span>工作液类别</span>
            <select v-model="mixForm.category" data-testid="field-mix-category">
              <option v-for="option in CATEGORY_OPTIONS" :key="option" :value="option">{{ option }}</option>
            </select>
          </label>
          <label class="span-2">
            <span>选择母液（仅显示同类别、未过期、有余量）</span>
            <select v-model="mixForm.stockId" data-testid="field-mix-stock">
              <option value="" disabled>请选择母液</option>
              <option v-for="stock in stockOptions" :key="stock.id" :value="stock.id">
                {{ stock.name }} · 余 {{ stock.volumeMl }} mL · {{ stock.expireDate }} 到期
              </option>
            </select>
          </label>
          <label class="span-2">
            <span>工作液名称</span>
            <input v-model="mixForm.workingName" data-testid="field-mix-name" type="text" placeholder="如 D-76 工作液 B" />
          </label>
          <label>
            <span>配制日期</span>
            <input v-model="mixForm.mixedAt" data-testid="field-mix-date" type="date" />
          </label>
          <div class="span-2">
            <DilutionInput
              v-model:ratio="mixForm.dilution"
              v-model:working-volume-ml="mixForm.targetVolumeMl"
              ratio-test-id="field-mix-dilution"
              volume-test-id="field-mix-volume"
            />
          </div>
          <div class="span-1 mix-check" :class="`mix-check--${selectedMixStock && !stockEnough ? 'rose' : 'cyan'}`">
            <template v-if="selectedMixStock">
              <strong data-testid="mix-required-ml">需母液 {{ requiredMl }} mL</strong>
              <span>所选母液余量 {{ selectedMixStock.volumeMl }} mL</span>
              <span v-if="stockEnough">余量充足，配制后余 {{ selectedMixStock.volumeMl - requiredMl }} mL</span>
              <span v-else class="mix-check__warn" data-testid="mix-shortage">余量不足，无法配制</span>
            </template>
            <template v-else>
              <strong>等待选择母液</strong>
              <span>过期或余量为 0 的母液不能选择</span>
            </template>
          </div>
        </div>
        <div class="form-actions">
          <button type="button" class="ghost-button" @click="showMixForm = false">取消</button>
          <button
            type="submit"
            class="primary-button"
            data-testid="submit-mix"
            :disabled="savingMix || mixForm.stockId === '' || !stockEnough"
          >
            {{ savingMix ? '配制中…' : '扣减母液并生成工作液' }}
          </button>
        </div>
      </form>

      <form v-if="showManualForm" class="inline-form" data-testid="form-developer" @submit.prevent="submitManual">
        <div class="inline-form__head">
          <div>
            <h2>手工登记工作液</h2>
            <p>用于登记直接获得的工作液；该记录来源标记为“未追溯”，不会补造母液。</p>
          </div>
        </div>
        <div class="form-grid form-grid--three">
          <label>
            <span>名称</span>
            <input v-model="manualForm.name" data-testid="field-name" type="text" placeholder="如 柯达 D-76 工作液 A" />
          </label>
          <label>
            <span>类型</span>
            <select v-model="manualForm.category" data-testid="field-category">
              <option v-for="option in CATEGORY_OPTIONS" :key="option" :value="option">{{ option }}</option>
            </select>
          </label>
          <label>
            <span>状态</span>
            <select v-model="manualForm.state" data-testid="field-state">
              <option value="新配">新配</option>
              <option value="在用">在用</option>
              <option value="报废">报废</option>
            </select>
          </label>
          <div class="span-2">
            <DilutionInput
              v-model:ratio="manualForm.dilution"
              v-model:working-volume-ml="manualForm.volumeMl"
              ratio-test-id="field-dilution"
              volume-test-id="field-volumeMl"
            />
          </div>
          <label>
            <span>配制日期</span>
            <input v-model="manualForm.mixedAt" data-testid="field-mixedAt" type="date" />
          </label>
          <label>
            <span>可冲上限</span>
            <input v-model.number="manualForm.maxRolls" data-testid="field-maxRolls" type="number" min="1" max="100" />
          </label>
          <label>
            <span>已冲卷数</span>
            <input v-model.number="manualForm.usedRolls" data-testid="field-usedRolls" type="number" min="0" max="100" />
          </label>
        </div>
        <div class="form-actions">
          <button type="button" class="ghost-button" @click="showManualForm = false">取消</button>
          <button type="submit" class="primary-button" data-testid="submit-developer" :disabled="savingManual">
            {{ savingManual ? '保存中…' : '保存工作液' }}
          </button>
        </div>
      </form>

      <div class="dev-grid">
        <article
          v-for="developer in developerStore.developers"
          :key="developer.id"
          class="entity-card developer-card"
          :class="{ 'entity-card--muted': developer.state === '报废' || developer.state === '已撤销' }"
          data-testid="row-developer"
        >
          <div class="entity-card__main">
            <div class="entity-card__title">
              <div>
                <span class="status-chip" :class="`status--${stateTone(developer)}`">{{ developer.state }}</span>
                <h2>{{ developer.name }}</h2>
              </div>
              <button
                v-if="developer.state !== '报废' && developer.state !== '已撤销'"
                type="button"
                class="text-button text-button--danger"
                @click="scrapDeveloper(developer.id)"
              >
                标记报废
              </button>
            </div>
            <dl class="data-pairs">
              <div><dt>类型 / 稀释</dt><dd>{{ developer.category }} · {{ developer.dilution }}</dd></div>
              <div><dt>工作液容量</dt><dd>{{ developer.volumeMl }} mL</dd></div>
              <div><dt>配制日期</dt><dd>{{ developer.mixedAt }}</dd></div>
              <div>
                <dt>来源</dt>
                <dd v-if="developer.sourceTraced && developer.sourceStockId !== undefined">
                  <span class="source-tag source-tag--traced">来自母液：{{ stockById(developer.sourceStockId)?.name ?? `#${developer.sourceStockId}` }}</span>
                </dd>
                <dd v-else><span class="source-tag source-tag--untraced" data-testid="source-untraced">来源未追溯</span></dd>
              </div>
            </dl>
            <div v-if="developer.state !== '已撤销'" class="life-meter">
              <div class="life-meter__head">
                <span>剩余 {{ remainingRolls(developer.maxRolls, developer.usedRolls) }} 卷</span>
                <span>已用 {{ developer.usedRolls }} / {{ developer.maxRolls }}</span>
              </div>
              <div class="life-meter__track">
                <i :style="{ width: `${Math.min(100, developer.usedRolls / developer.maxRolls * 100)}%` }"></i>
              </div>
              <small v-if="remainingRolls(developer.maxRolls, developer.usedRolls) === 0">余量已耗尽，建议报废并重新配制。</small>
            </div>
          </div>
        </article>
      </div>
    </template>

    <!-- ================= 分装配制记录 ================= -->
    <template v-if="activeTab === 'ledger'">
      <div class="stat-strip">
        <StatBadge label="配制记录" :value="stockStore.mixes.length" hint="全部台账流水" tone="cyan" />
        <StatBadge label="正常" :value="stockStore.activeMixes.length" hint="母液已扣减" tone="amber" />
        <StatBadge label="已撤销" :value="stockStore.revokedMixes.length" hint="余量已恢复并留痕" tone="rose" />
      </div>

      <div class="panel">
        <div class="panel__head">
          <div>
            <h2>分装配制台账</h2>
            <p>每一笔由母液调工作液的配制都在此留痕；未冲洗的记录可撤销并回退母液余量。</p>
          </div>
          <span class="count-pill">记录数 <strong data-testid="count-mix">{{ stockStore.mixes.length }}</strong></span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>批次 / 日期</th>
                <th>母液 → 工作液</th>
                <th>类别 / 稀释</th>
                <th>扣减母液 / 目标容量</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="mix in stockStore.mixes"
                :key="mix.id"
                :class="{ 'ledger-row--revoked': mix.status === '已撤销' }"
                data-testid="row-mix"
              >
                <td>
                  <strong>{{ mix.batchNo }}</strong>
                  <small>{{ mix.mixedAt }}</small>
                </td>
                <td>
                  <strong>{{ mix.stockName }}</strong>
                  <small>→ {{ mix.workingName }}</small>
                </td>
                <td>{{ mix.category }} · {{ mix.dilution }}</td>
                <td>
                  <strong class="accent-number">{{ mix.stockUsedMl }} mL</strong>
                  <small>出 {{ mix.targetVolumeMl }} mL</small>
                </td>
                <td>
                  <span class="status-chip" :class="`status--${mixRowTone(mix)}`">{{ mix.status }}</span>
                  <small class="ledger-hint">{{ mixRowHint(mix) }}</small>
                </td>
                <td>
                  <button
                    v-if="mix.status === '正常' && (developerById(mix.workingDeveloperId)?.usedRolls ?? 0) === 0"
                    type="button"
                    class="text-button text-button--danger"
                    data-testid="revoke-mix"
                    @click="revokeMix(mix)"
                  >
                    撤销配制
                  </button>
                  <span v-else-if="mix.status === '正常'" class="ledger-locked">已冲洗，不可撤销</span>
                  <span v-else class="ledger-locked">记录已留档</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="stockStore.mixes.length === 0" class="inline-empty">
            暂无配制记录。在“工作液”页由母液调一次工作液后，这里会生成台账流水。
          </div>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.ledger-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 18px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: rgba(255, 253, 249, 0.8);
  width: fit-content;
  flex-wrap: wrap;
}

.ledger-tab {
  padding: 9px 20px;
  border: none;
  border-radius: 10px;
  color: var(--ink-soft);
  background: transparent;
  font-size: 14px;
  cursor: pointer;
  transition: all 150ms ease;
}

.ledger-tab--active {
  color: #fff5e8;
  background: linear-gradient(145deg, #403127, #765039);
  box-shadow: 0 4px 12px rgba(61, 47, 32, 0.18);
}

.ledger-toolbar {
  display: flex;
  gap: 10px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.unit-em {
  display: block;
  margin-top: -26px;
  margin-right: 12px;
  text-align: right;
  color: var(--ink-soft);
  font-size: 11px;
  font-style: normal;
  pointer-events: none;
}

.stock-note {
  color: var(--ink-soft);
  font-size: 12px;
}

.entity-card--muted {
  opacity: 0.62;
}

.source-tag {
  display: inline-block;
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 11px;
}

.source-tag--traced {
  color: #285f66;
  background: #e0f0ef;
}

.source-tag--untraced {
  color: #7a6a55;
  background: #efe8db;
}

.mix-check {
  display: grid;
  align-content: center;
  gap: 4px;
  padding: 10px 14px;
  border-radius: 10px;
  border: 1px solid rgba(41, 127, 137, 0.2);
  color: #285f66;
  background: #eef8f7;
}

.mix-check--rose {
  border-color: rgba(174, 72, 70, 0.3);
  color: #8a3a38;
  background: #fbeeed;
}

.mix-check span {
  font-size: 12px;
  color: inherit;
  opacity: 0.85;
}

.mix-check__warn {
  font-weight: 600;
}

.ledger-hint {
  display: block;
  margin-top: 4px;
}

.ledger-row--revoked {
  opacity: 0.6;
}

.ledger-row--revoked td {
  text-decoration: line-through;
  text-decoration-color: rgba(122, 106, 85, 0.45);
}

.ledger-row--revoked .ledger-hint,
.ledger-row--revoked .status-chip,
.ledger-row--revoked .ledger-locked {
  text-decoration: none;
}

.ledger-locked {
  color: var(--ink-soft);
  font-size: 12px;
}

.status--slate {
  color: #5c6470;
  background: #e7eaef;
}
</style>

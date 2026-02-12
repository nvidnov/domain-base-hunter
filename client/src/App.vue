<script setup>
import { computed, onMounted, ref, watch } from 'vue';
import SearchForm from './components/SearchForm.vue';
import ResultsTable from './components/ResultsTable.vue';
import { checkDomain, getCapabilities, searchDomains } from './api/domains';

const state = ref({
  pageSize: 50,
  criteria: {
    tld: 'com',
    ageYearsFrom: '',
    ageYearsTo: '',
    creationDateFrom: '',
    creationDateTo: '',
    waybackMinSnapshots: '',
    domainStartsWith: '',
    domainEndsWith: '',
    safeSpamhausOnly: false,
    safeViewsTotalOnly: false,
    countryByIp: '',
    registrarContains: '',
    technologiesContains: '',
    responseStatusContains: '',
    detectedHostsMin: '',
    detectedHostsMax: '',
    expirationFrom: '',
    expirationTo: '',
  },
});

const items = ref([]);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const error = ref(null);
const capabilities = ref(null);
const checksByDomain = ref({});
const checkingByDomain = ref({});

const showResults = computed(() => loading.value || !!error.value || (items.value?.length || 0) > 0);

async function runSearch(nextPage = 1) {
  loading.value = true;
  error.value = null;
  try {
    const res = await searchDomains({
      page: nextPage,
      pageSize: Number(state.value.pageSize) || 50,
      criteria: state.value.criteria || {},
    });
    page.value = res.page || nextPage;
    total.value = Number(res.total) || 0;
    items.value = res.items || [];
  } catch (e) {
    error.value = e?.message || 'Search failed';
    items.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

async function runCheck(domain) {
  const d = String(domain || '').trim();
  if (!d) return;
  checkingByDomain.value = { ...checkingByDomain.value, [d]: true };
  try {
    const res = await checkDomain(d);
    checksByDomain.value = { ...checksByDomain.value, [d]: res };
  } catch (e) {
    checksByDomain.value = {
      ...checksByDomain.value,
      [d]: { domain: d, error: e?.message || 'Check failed' },
    };
  } finally {
    const next = { ...checkingByDomain.value };
    delete next[d];
    checkingByDomain.value = next;
  }
}

onMounted(() => {
  try {
    const cached = localStorage.getItem('domainsDbApp.searchState');
    if (cached) state.value = { ...state.value, ...JSON.parse(cached) };
  } catch {}

  // Cleanup legacy criteria that may still exist in cached state
  try {
    const c = (state.value && state.value.criteria) || {};
    delete c.lifecycleState;
    delete c.expiringWithinDays;
    delete c.expiredState;
    state.value.criteria = c;
  } catch {}

  getCapabilities()
    .then((c) => {
      capabilities.value = c;
    })
    .catch(() => {
      capabilities.value = null;
    });
});

watch(
  () => state.value,
  (val) => {
    try {
      localStorage.setItem('domainsDbApp.searchState', JSON.stringify(val));
    } catch {}
  },
  { deep: true }
);
</script>

<template>
  <div class="app">
    <header class="header">
      <h1 class="h1">Domains DB App</h1>
      <p class="sub">Отбор доменов из Postgres по критериям</p>
    </header>

    <main class="main" :class="{ single: !showResults }">
      <aside class="left">
        <SearchForm
          v-model="state"
          :loading="loading"
          :capabilities="capabilities"
          @search="runSearch(1)"
        />
      </aside>
      <section v-if="showResults" class="right">
        <ResultsTable
          :items="items"
          :loading="loading"
          :error="error"
          :total="total"
          :page="page"
          :page-size="Number(state.pageSize) || 50"
          :checks="checksByDomain"
          :checking="checkingByDomain"
          @update:page="runSearch"
          @check="runCheck"
        />
      </section>
    </main>
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
  background: #0d0f14;
  color: #e6e9ef;
}

.header {
  padding: 18px 20px;
  border-bottom: 1px solid #252a36;
  background: #14171f;
}

.h1 {
  margin: 0;
  font-size: 20px;
}

.sub {
  margin: 4px 0 0;
  color: #8b909a;
  font-size: 13px;
}

.main {
  display: grid;
  grid-template-columns: 360px 1fr;
  gap: 0;
  min-height: calc(100vh - 64px);
}

.main.single {
  grid-template-columns: minmax(320px, 420px);
  justify-content: start;
}

.left {
  padding: 16px;
  border-right: 1px solid #252a36;
  background: #14171f;
  overflow: auto;
}

.main.single .left {
  border-right: none;
}

.right {
  padding: 16px;
  overflow: auto;
  display: flex;
  min-height: 0;
}

.right :deep(.card) {
  flex: 1;
}

@media (max-width: 900px) {
  .main {
    grid-template-columns: 1fr;
  }
  .left {
    border-right: none;
    border-bottom: 1px solid #252a36;
  }
}
</style>

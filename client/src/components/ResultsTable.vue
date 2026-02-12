<script setup>
import { computed } from 'vue';

const props = defineProps({
  items: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  error: { type: String, default: null },
  total: { type: Number, default: 0 },
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 50 },
  checks: { type: Object, default: () => ({}) },
  checking: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:page', 'check']);

const totalPages = computed(() =>
  Math.max(1, Math.ceil((Number(props.total) || 0) / (Number(props.pageSize) || 1)))
);

const columns = [
  { key: 'domain', label: 'Domain' },
  { key: 'tld', label: 'TLD' },
  { key: 'country_by_ip', label: 'Country' },
  { key: 'detected_hosts', label: 'Hosts' },
  { key: 'domain_creation_date', label: 'Created' },
  { key: 'domain_expiration_date', label: 'Expires' },
  { key: 'registrar', label: 'Registrar' },
  { key: 'technologies', label: 'Technologies' },
  { key: 'response_status', label: 'Status' },
  { key: 'spamhausCheck', label: 'Spamhaus' },
  { key: 'waybackCheck', label: 'Wayback' },
  { key: 'checks', label: 'Checks' },
];

function cellValue(row, key) {
  const v = row?.[key];
  if (v == null || v === '') return '—';
  return String(v);
}

function goPrev() {
  emit('update:page', Math.max(1, Number(props.page) - 1));
}
function goNext() {
  emit('update:page', Math.min(totalPages.value, Number(props.page) + 1));
}

function waybackCell(domain) {
  const r = props.checks?.[domain];
  if (!r) return { text: '—', kind: 'muted', link: null };
  if (r.error) return { text: 'ошибка', kind: 'error', link: null };
  const w = r.wayback;
  if (!w) return { text: '—', kind: 'muted', link: null };
  if (w.error) return { text: 'ошибка', kind: 'error', link: w.link || null };

  const link = w.link || null;

  if (w.hasSnapshots) {
    const label = w.lastSnapshot ? `Есть (${w.lastSnapshot})` : 'Есть';
    return { text: label, kind: 'good', link };
  }

  return { text: 'Нет', kind: 'muted', link };
}

function spamhausCell(domain) {
  const r = props.checks?.[domain];
  if (!r) return { text: '—', kind: 'muted' };
  if (r.error) return { text: 'ошибка', kind: 'error' };
  const s = r.spamhaus;
  if (!s) return { text: '—', kind: 'muted' };
  if (s.error) return { text: 'ошибка', kind: 'error' };
  if (s.status === 'pending') return { text: 'PENDING', kind: 'muted' };
  if (s.listed === true) return { text: 'LISTED', kind: 'bad' };
  if (s.listed === false) return { text: 'OK', kind: 'good' };
  return { text: 'UNKNOWN', kind: 'muted' };
}
</script>

<template>
  <div class="card">
    <div class="header">
      <h2 class="title">Результаты</h2>
      <span class="meta">{{ Number(total || 0).toLocaleString() }} строк</span>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-else-if="loading" class="muted">Загрузка…</p>
    <p v-else-if="!items.length" class="muted">Пусто. Задайте критерии и нажмите “Найти”.</p>

    <div v-else class="tableWrap">
      <table class="table">
        <thead>
          <tr>
            <th v-for="c in columns" :key="c.key" class="th">{{ c.label }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in items" :key="row.domain + '-' + i" class="tr">
            <td v-for="c in columns" :key="c.key" class="td">
              <template v-if="c.key === 'domain' && row.domain">
                <a class="link" :href="'https://' + row.domain" target="_blank" rel="noopener">{{ row.domain }}</a>
              </template>
              <template v-else-if="c.key === 'waybackCheck'">
                <template v-if="row.domain">
                  <a
                    v-if="waybackCell(row.domain).link"
                    class="pill"
                    :class="waybackCell(row.domain).kind"
                    :href="waybackCell(row.domain).link"
                    target="_blank"
                    rel="noopener"
                    >{{ waybackCell(row.domain).text }}</a
                  >
                  <span v-else class="pill" :class="waybackCell(row.domain).kind">{{
                    waybackCell(row.domain).text
                  }}</span>
                </template>
                <span v-else class="pill muted">—</span>
              </template>
              <template v-else-if="c.key === 'spamhausCheck'">
                <span
                  v-if="row.domain"
                  class="pill"
                  :class="spamhausCell(row.domain).kind"
                  >{{ spamhausCell(row.domain).text }}</span
                >
                <span v-else class="pill muted">—</span>
              </template>
              <template v-else-if="c.key === 'checks'">
                <button
                  class="btnCheck"
                  type="button"
                  :disabled="!row.domain || !!checking?.[row.domain]"
                  @click="emit('check', row.domain)"
                >
                  {{ checking?.[row.domain] ? 'Проверяем…' : 'Проверить' }}
                </button>
              </template>
              <template v-else>{{ cellValue(row, c.key) }}</template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="pager">
      <button class="btnSecondary" type="button" :disabled="page <= 1" @click="goPrev">Назад</button>
      <span class="meta">Стр. {{ page }} / {{ totalPages }}</span>
      <button class="btnSecondary" type="button" :disabled="page >= totalPages" @click="goNext">Вперёд</button>
    </div>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid #252a36;
  border-radius: 12px;
  padding: 16px;
  background: #14171f;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.title {
  margin: 0;
  font-size: 18px;
}

.meta {
  color: #8b909a;
  font-size: 13px;
}

.muted {
  color: #8b909a;
  margin: 0;
}

.error {
  margin: 0 0 12px;
  padding: 10px 12px;
  border: 1px solid #fca5a5;
  border-radius: 10px;
  color: #fca5a5;
  background: rgba(252, 165, 165, 0.08);
}

.tableWrap {
  overflow: auto;
  border: 1px solid #252a36;
  border-radius: 10px;
  flex: 1;
  min-height: 0;
}

.table {
  width: 100%;
  border-collapse: collapse;
}

.th {
  text-align: left;
  font-size: 12px;
  color: #8b909a;
  background: #0d0f14;
  padding: 10px 12px;
  border-bottom: 1px solid #252a36;
  white-space: nowrap;
}

.td {
  padding: 10px 12px;
  border-bottom: 1px solid #252a36;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  font-size: 12px;
  vertical-align: top;
}

.tr:hover .td {
  background: rgba(125, 211, 252, 0.05);
}

.link {
  color: #7dd3fc;
  text-decoration: none;
}
.link:hover {
  text-decoration: underline;
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 12px;
}

.btnSecondary {
  padding: 8px 10px;
  border-radius: 10px;
  border: 1px solid #252a36;
  background: #0d0f14;
  color: #e6e9ef;
  cursor: pointer;
}

.btnSecondary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btnCheck {
  padding: 6px 8px;
  border-radius: 10px;
  border: 1px solid #252a36;
  background: #0d0f14;
  color: #e6e9ef;
  cursor: pointer;
  white-space: nowrap;
}

.btnCheck:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px 8px;
  border-radius: 999px;
  border: 1px solid #252a36;
  background: #0d0f14;
  font-weight: 700;
  letter-spacing: 0.02em;
  font-size: 11px;
  line-height: 1;
}

.pill.muted {
  color: #8b909a;
}

.pill.ok {
  color: #fde68a;
  border-color: rgba(253, 230, 138, 0.3);
}

.pill.good {
  color: #86efac;
  border-color: rgba(134, 239, 172, 0.3);
}

.pill.bad {
  color: #fca5a5;
  border-color: rgba(252, 165, 165, 0.35);
}

.pill.error {
  color: #fca5a5;
  border-color: rgba(252, 165, 165, 0.35);
}

</style>


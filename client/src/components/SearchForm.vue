<script setup>
import { computed, ref } from 'vue';

const props = defineProps({
  modelValue: { type: Object, required: true },
  loading: { type: Boolean, default: false },
  capabilities: { type: Object, default: null },
});

const emit = defineEmits(['update:modelValue', 'search']);

const prevTld = ref('');

function updateCriteria(key, value) {
  emit('update:modelValue', {
    ...props.modelValue,
    criteria: { ...(props.modelValue.criteria || {}), [key]: value },
  });
}

function updateField(key, value) {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

const pageSizeModel = computed(() => Number(props.modelValue.pageSize) || 50);

const onlyCom = computed(() => {
  const raw = String(props.modelValue.criteria?.tld || '').trim().toLowerCase();
  const normalized = raw.startsWith('.') ? raw.slice(1) : raw;
  return normalized === 'com';
});

function setOnlyCom(checked) {
  if (checked) {
    const cur = String(props.modelValue.criteria?.tld || '').trim();
    if (cur && cur.toLowerCase() !== 'com' && cur.toLowerCase() !== '.com') prevTld.value = cur;
    updateCriteria('tld', 'com');
  } else {
    updateCriteria('tld', prevTld.value || '');
  }
}


</script>

<template>
  <div class="card">
    <h2 class="title">Фильтры</h2>

    <div class="grid">
      <label class="check">
        <input
          class="checkbox"
          type="checkbox"
          :checked="onlyCom"
          :disabled="loading"
          @change="setOnlyCom($event.target.checked)"
        />
        <span>Только .com</span>
      </label>

      <div class="row2">
        <label class="field">
          <span class="label">Возраст (лет) — от</span>
          <input
            class="input"
            type="number"
            min="0"
            :value="modelValue.criteria?.ageYearsFrom || ''"
            :disabled="loading"
            @input="updateCriteria('ageYearsFrom', $event.target.value)"
          />
        </label>

        <label class="field">
          <span class="label">Возраст (лет) — до</span>
          <input
            class="input"
            type="number"
            min="0"
            :value="modelValue.criteria?.ageYearsTo || ''"
            :disabled="loading"
            @input="updateCriteria('ageYearsTo', $event.target.value)"
          />
        </label>
      </div>

      <div class="row2">
        <label class="field">
          <span class="label">Дата регистрации — от</span>
          <input
            class="input"
            type="date"
            :value="modelValue.criteria?.creationDateFrom || ''"
            :disabled="loading"
            @input="updateCriteria('creationDateFrom', $event.target.value)"
          />
        </label>

        <label class="field">
          <span class="label">Дата регистрации — до</span>
          <input
            class="input"
            type="date"
            :value="modelValue.criteria?.creationDateTo || ''"
            :disabled="loading"
            @input="updateCriteria('creationDateTo', $event.target.value)"
          />
        </label>
      </div>

      <label class="field">
        <span class="label">TLD (через запятую)</span>
        <input
          class="input"
          type="text"
          placeholder="com, net, org"
          :value="modelValue.criteria?.tld || ''"
          :disabled="loading || onlyCom"
          @input="updateCriteria('tld', $event.target.value)"
        />
      </label>

      <div class="row2">
        <label class="field">
          <span class="label">Домен начинается на</span>
          <input
            class="input"
            type="text"
            placeholder="shop"
            :value="modelValue.criteria?.domainStartsWith || ''"
            :disabled="loading"
            @input="updateCriteria('domainStartsWith', $event.target.value)"
          />
        </label>

        <label class="field">
          <span class="label">Домен заканчивается на</span>
          <input
            class="input"
            type="text"
            placeholder="store.com"
            :value="modelValue.criteria?.domainEndsWith || ''"
            :disabled="loading"
            @input="updateCriteria('domainEndsWith', $event.target.value)"
          />
        </label>
      </div>

      <label class="field">
        <span class="label">Лимит на страницу</span>
        <select
          class="input"
          :value="pageSizeModel"
          :disabled="loading"
          @change="updateField('pageSize', Number($event.target.value))"
        >
          <option :value="25">25</option>
          <option :value="50">50</option>
          <option :value="100">100</option>
          <option :value="200">200</option>
          <option :value="500">500</option>
        </select>
      </label>
    </div>

    <button class="btn" type="button" :disabled="loading" @click="$emit('search')">
      {{ loading ? 'Поиск...' : 'Найти' }}
    </button>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid #252a36;
  border-radius: 12px;
  padding: 16px;
  background: #14171f;
}

.title {
  margin: 0 0 12px;
  font-size: 18px;
}

.grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 12px;
  min-width: 0;
}

.row2 {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  min-width: 0;
}

@media (max-width: 520px) {
  .row2 {
    grid-template-columns: 1fr;
  }
}

.check {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #252a36;
  background: #0d0f14;
  color: #e6e9ef;
  user-select: none;
  min-width: 0;
}

.checkbox {
  width: 16px;
  height: 16px;
  accent-color: #7dd3fc;
}

.field {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.label {
  font-size: 12px;
  color: #8b909a;
}

.input {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid #252a36;
  background: #0d0f14;
  color: #e6e9ef;
}

.btn {
  margin-top: 12px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  border-radius: 10px;
  background: #7dd3fc;
  color: #0d0f14;
  font-weight: 600;
  cursor: pointer;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>


<script setup>
// Vue 3 single-file component implementing the shared matrix UI contract. Uses v-model
// (two-way binding) on the input, so it is a controlled field backed by reactive state
// — driving it with real keystrokes proves the tools work through Vue's reactivity.
import { ref } from 'vue'

const name = ref('')
const status = ref('No greeting yet')

function greet() {
  const who = name.value.trim() || 'stranger'
  status.value = `Hello, ${who}!`
  console.log(`greeted ${who}`)
}
</script>

<template>
  <main>
    <h1>Vue fixture</h1>
    <label>Your name <input id="name" aria-label="Your name" v-model="name" /></label>
    <button id="greet" type="button" @click="greet">Greet</button>
    <p id="status">{{ status }}</p>
  </main>
</template>

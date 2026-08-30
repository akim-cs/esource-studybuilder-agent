const keyInput = document.getElementById('apiKey') as HTMLInputElement
const saveBtn = document.getElementById('save') as HTMLButtonElement
const statusEl = document.getElementById('status') as HTMLParagraphElement

chrome.storage.local.get('geminiApiKey', ({ geminiApiKey }) => {
  if (geminiApiKey) keyInput.value = geminiApiKey as string
})

saveBtn.addEventListener('click', () => {
  const key = keyInput.value.trim()
  if (!key) {
    statusEl.textContent = 'Please enter a key.'
    statusEl.style.color = 'red'
    return
  }
  chrome.storage.local.set({ geminiApiKey: key }, () => {
    statusEl.textContent = 'Saved.'
    statusEl.style.color = 'green'
  })
})

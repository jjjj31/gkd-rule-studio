declare global {
  interface Window {
    GkdAndroidBridge?: {
      copyToClipboard?: (text: string) => void;
    };
  }
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (window.GkdAndroidBridge?.copyToClipboard) {
    window.GkdAndroidBridge.copyToClipboard(text);
    return;
  }

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  copyWithTextareaFallback(text);
}

function copyWithTextareaFallback(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

# Ollama UI – User Documentation

## 1. Overview

Ollama UI is a modern web interface for managing and interacting with your Ollama server and models. It provides streamlined workflows for host management, model operations, and chat-based interactions, all in a clean, responsive design.

<PICTURE: Main Dashboard Screenshot>

---

## 2. Getting Started

### Accessing Ollama UI

- Open your browser and navigate to the Ollama UI address provided by your administrator or deployment.
- The main view presents navigation options for Chat, Models, and News.

<PICTURE: Navigation Bar Highlight>

### Layout

- The header displays the currently active host and provides quick access to host management and refresh controls.
- The main content area changes based on the selected navigation (Chat, Models, News).

---

## 3. Host Management

### Viewing and Switching Hosts

- The active host is shown in the header as a colored pill, indicating status (OK/DOWN) and latency.
- To manage hosts, click the gear icon next to the host indicator.

<PICTURE: Host Indicator and Gear Button>

### Host Manager Modal

- Add, edit, delete, and test hosts in a dedicated modal.
- Activate a host by selecting it; the green dot marks the active target for all operations.
- Host details (URL, label) are shown, and you can test connectivity before activating.

<PICTURE: Host Manager Modal Open>

---

## 4. Chat

### Using the Chat Interface

- The chat view allows you to interact with your models in a conversational format.
- Type your message and press Enter to send.
- Responses from the model appear in real-time.

<PICTURE: Chat Panel in Action>

---

## 5. Models

### Viewing Models

- The Models section lists all available models on the active host.
- Each model card shows details and available actions.

### Pulling and Deleting Models

- Use the pull button to fetch new models from the registry.
- Delete models you no longer need with the delete action.
- Progress and logs are shown during model operations.

<PICTURE: Model List and Actions>

---

## 6. News / Release Notes

### Viewing Updates

- The News section displays release notes and updates in a readable format.
- Markdown formatting is fully supported, including tables, links, and images.
- Toggle between rendered and raw markdown views for full transparency.

<PICTURE: News/Release Notes View>

---

## 7. Troubleshooting & Tips

- If a host shows as DOWN, check your network connection and host configuration.
- For missing images in News, ensure assets are placed in `/public/news/`.
- Use the refresh button in the header to retest host connectivity.
- For further help, consult your administrator or visit the project’s documentation site.

---

## 8. Customization

- You can add your own hosts, labels, and model sources as needed.
- Release notes can be updated by editing the `News.md` file and placing images in the `/public/news/` directory.

---

## 9. FAQ

**Q: How do I switch between hosts?**  
A: Click the gear icon in the header, select your desired host, and activate it.

**Q: Where do I put images for release notes?**  
A: Place them in `/public/news/` and reference them in `News.md`.

**Q: What does the colored pill in the header mean?**  
A: It shows the status of the active host: green for reachable, red for down, yellow for not configured.

---

## 10. Contact & Support

GITHUB LINKS

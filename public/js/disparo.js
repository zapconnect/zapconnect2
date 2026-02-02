function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function toBase64(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(file);
    });
}

document.getElementById("btnStart").addEventListener("click", startDisparo);

async function startDisparo() {
    const numbers = document.getElementById("numbers").value
        .trim()
        .split("\n")
        .map(n => n.replace(/\D/g, "")) // remove caracteres inválidos
        .filter(n => n.length >= 12);   // 55 + DDD + número

    const message = document.getElementById("message").value.trim();
    const progress = document.getElementById("progress");
    const fileInput = document.getElementById("file");

    if (!numbers.length || !message) {
        alert("Preencha os números corretamente e a mensagem!");
        return;
    }

    progress.style.display = "block";
    progress.innerHTML = "<b>🚀 Enviando...</b><br>";

    let fileBase64 = null;

    if (fileInput.files.length > 0) {
        const file = fileInput.files[0];
        fileBase64 = await toBase64(file);
    }

    for (let i = 0; i < numbers.length; i++) {
        const num = numbers[i];
        progress.innerHTML += `📤 Enviando para <b>${num}</b>... `;

        try {
            const resp = await fetch("/api/disparo", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    number: num,
                    message,
                    file: fileBase64,
                    filename: fileInput.files[0]?.name || null
                })
            });

            if (!resp.ok) throw new Error();

            progress.innerHTML += `✔️ <span style="color:green">Sucesso!</span><br>`;
        } catch {
            progress.innerHTML += `❌ <span style="color:red">Falhou!</span><br>`;
        }

        await sleep(3000); // delay maior = menos risco de ban
    }

    progress.innerHTML += "<br><b>🎉 Disparo finalizado!</b>";
}

const express = require("express");
const path = require("path");

const app = express();
const PORT = 3000;

// Serve files from the project root
app.use(express.static(__dirname));

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
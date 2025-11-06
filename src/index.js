const app = require('./service.js');
const metrics = require('./metrics.js');

const port = process.argv[2] || 3000;
metrics.start(1000);
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});

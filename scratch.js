const axios = require('axios');
axios.post('http://localhost:4001/task', {type: 'interactive', complexity: 2})
  .then(res => console.log('OK', res.data))
  .catch(err => {
    console.log('MESSAGE:', err.message);
    console.log('JSON:', JSON.stringify(err.response?.data));
  });

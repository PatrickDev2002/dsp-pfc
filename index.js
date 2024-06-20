const express = require("express")
const { createServer } = require("node:http")
const path = require("node:path")
const { join } = require('node:path')
const { Server } = require('socket.io')
const cluster = require('cluster');
const os = require('os');

const numCPUs = os.cpus().length;
const startPort = 2999;

if (cluster.isMaster) {
    console.log(`Master ${process.pid} is running`);

    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} died`);
        cluster.fork();
    });
} else {
    const app = express()
    const server = createServer(app)
    const port = startPort + cluster.worker.id
    const io = new Server(server)

    const usedPseudos = new Set()
    const salons = {}

    io.on('connection', (socket) => {
        console.log('Joueur connecté', salons)

        socket.on('typing', () => {
            socket.broadcast.emit('player typing', socket.id);
        });

        socket.on('stop typing', () => {
            socket.broadcast.emit('player stop typing', socket.id);
        });
        
        socket.on('disconnect', () => {
            const salonId = socket.salonId;  // Récupérer le salonId de la session de socket
            console.log(salonId, salons)
            if (salons[salonId] != null) {
                salons[salonId].players = salons[salonId].players.filter(player => player.id !== socket.id);
                delete salons[salonId].scores[socket.pseudo];
                io.to(salonId).emit('updatePlayers', salons[salonId].players.map(player => player.pseudo));

                // Si le salon est vide, le supprimer
                if (salons[salonId].players.length === 0) {
                    delete salons[salonId];
                }
            }
            usedPseudos.clear();
            console.log('Joueur déconnecté', salons)
        });

        socket.on("checkPseudo", (pseudo, callback) => {
            if (usedPseudos.has(pseudo)) {
                callback(false)
            } else {
                callback(true)
            }
        });

        socket.on("setPseudo", (pseudo) => {
            usedPseudos.add(pseudo)
            socket.pseudo = pseudo
        });

        socket.on('joinSalon', (data) => {
            const salonId = data.salonId;
            const pseudoJoueur = data.pseudo;
            socket.salonId = salonId;  // Enregistrer le salonId dans la session du socket
            socket.pseudo = pseudoJoueur;
            socket.join(salonId);

            if (!salons[salonId]) {
                salons[salonId] = { players: [], rounds: 1, scores: {} };
            }

            if (salons[salonId].players.length >= 2) {
                socket.emit('salonFull');
                return;
            }

            salons[salonId].players.push({ id: socket.id, pseudo: pseudoJoueur });
            salons[salonId].scores[pseudoJoueur] = 0;

            socket.emit('joinedSalon', salonId);
            io.to(salonId).emit('updatePlayers', salons[salonId].players.map(player => player.pseudo));

            socket.on('ready', () => {
                io.to(salonId).emit('playerReady', pseudoJoueur);
            });

            socket.on('choice', (choice) => {
                socket.choice = choice;
                io.to(salonId).emit('playerChoice', { playerId: pseudoJoueur, choice });

                console.log(salons[salonId]);
                // Vérifier si tous les joueurs ont fait un choix
                if (salons[salonId].players.every(player => io.sockets.sockets.get(player.id).choice)) {
                    const choices = salons[salonId].players.map(player => ({
                        playerPseudo: player.pseudo,
                        choice: io.sockets.sockets.get(player.id).choice
                    }));

                    const result = determineWinner(choices);
                    if (!result.tie) {
                        result.winners.forEach(winner => {
                            salons[salonId].scores[winner.playerPseudo]++;
                        });
                    }

                    salons[salonId].rounds++;

                    // Envoyer les résultats
                    console.log(result);
                    io.to(salonId).emit('result', result);
                    io.to(salonId).emit('scoreUpdate', salons[salonId].scores);
                    io.to(salonId).emit('updateRounds', salons[salonId].rounds);

                    if (salons[salonId].rounds >= 10) {
                        let finalScores = Object.entries(salons[salonId].scores).sort((a, b) => b[1] - a[1]);
                        io.to(salonId).emit('finalResult', finalScores);

                        // Réinitialiser le salon pour une nouvelle partie
                        salons[salonId].rounds = 0;
                        for (let player in salons[salonId].scores) {
                            salons[salonId].scores[player] = 0;
                        }
                    } else {
                        salons[salonId].players.forEach(player => {
                            io.sockets.sockets.get(player.id).choice = null;
                        });
                    }
                }
            });
        });
    })

    app.get('/', (req, res) => {
        res.sendFile(join(__dirname, 'index.html'))
    })

    app.get("/partie/:salon", (req, res) => {
        res.sendFile(join(__dirname, "partie.html"))
    })

    app.get('/reset-pseudos', (req, res) => {
        usedPseudos.clear();
        res.send('Pseudos réinitialisés');
    })

    server.listen(port,() => {
        console.log(`Worker ${process.pid} is running on port ${port}`);
    })

    // fonctions
    function determineWinner(choices) {
        const outcomes = {
            'pierre': ['ciseaux'],
            'ciseaux': ['feuille'],
            'feuille': ['pierre', 'puit'],
            'puit': ['pierre', 'ciseaux']
        };

        let winners = [];
        let losers = [];
        let tie = false;

        for (let i = 0; i < choices.length; i++) {
            let currentPlayer = choices[i];
            let hasWon = true;

            for (let j = 0; j < choices.length; j++) {
                if (i !== j && !outcomes[currentPlayer.choice].includes(choices[j].choice)) {
                    hasWon = false;
                    break;
                }
            }

            if (hasWon) {
                winners.push(currentPlayer);
            } else {
                losers.push(currentPlayer);
            }
        }

        if (winners.length === 0 || winners.length === choices.length) {
            tie = true;
        }

        return { winners, losers, tie };
    }
}

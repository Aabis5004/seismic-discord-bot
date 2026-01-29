// ============================================
// SEISMIC DISCORD ANALYTICS BOT
// Tracks messages, roles, and user activity
// ============================================

const { Client, GatewayIntentBits, Partials, EmbedBuilder, SlashCommandBuilder, REST, Routes } = require('discord.js');
const admin = require('firebase-admin');

// ============================================
// CONFIGURATION - UPDATE THESE!
// ============================================
const CONFIG = {
    // Discord Bot Token (from Discord Developer Portal)
    DISCORD_TOKEN: process.env.DISCORD_TOKEN || 'YOUR_BOT_TOKEN_HERE',
    
    // Discord Application/Client ID
    CLIENT_ID: process.env.CLIENT_ID || 'YOUR_CLIENT_ID_HERE',
    
    // Seismic Server ID (right-click server -> Copy ID)
    GUILD_ID: process.env.GUILD_ID || 'YOUR_SERVER_ID_HERE',
    
    // Firebase Config
    FIREBASE_CONFIG: {
        apiKey: process.env.FIREBASE_API_KEY || "AIzaSyA8pkP36cH_sngGro7ocgOoAaWPGKWh4WE",
        authDomain: "seismic-polls.firebaseapp.com",
        databaseURL: "https://seismic-polls-default-rtdb.asia-southeast1.firebasedatabase.app",
        projectId: "seismic-polls",
    },
    
    // Role names to track (Mag levels)
    MAG_ROLES: ['Mag 1', 'Mag 2', 'Mag 3', 'Mag 4', 'Mag 5'],
    
    // Art channel names (to track art submissions)
    ART_CHANNELS: ['art', 'artwork', 'creations', 'fan-art', 'memes'],
    
    // Update leaderboard every X messages
    LEADERBOARD_UPDATE_INTERVAL: 10,
};

// ============================================
// INITIALIZE FIREBASE
// ============================================
let database;
try {
    // For Firebase Admin SDK (server-side)
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: CONFIG.FIREBASE_CONFIG.projectId,
                // Add service account credentials for production
            }),
            databaseURL: CONFIG.FIREBASE_CONFIG.databaseURL
        });
    }
    database = admin.database();
    console.log('✅ Firebase initialized');
} catch (error) {
    console.log('⚠️ Firebase Admin SDK not configured, using REST API fallback');
    database = null;
}

// ============================================
// FIREBASE REST API FALLBACK
// ============================================
const firebaseREST = {
    baseURL: CONFIG.FIREBASE_CONFIG.databaseURL,
    
    async get(path) {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(`${this.baseURL}/${path}.json`);
        return response.json();
    },
    
    async set(path, data) {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(`${this.baseURL}/${path}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        return response.json();
    },
    
    async update(path, data) {
        const fetch = (await import('node-fetch')).default;
        const response = await fetch(`${this.baseURL}/${path}.json`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        return response.json();
    },
    
    async increment(path, amount = 1) {
        const current = await this.get(path) || 0;
        await this.set(path, current + amount);
        return current + amount;
    }
};

// ============================================
// INITIALIZE DISCORD CLIENT
// ============================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
    ],
    partials: [Partials.Message, Partials.Channel],
});

// Message counter for batch updates
let messageCounter = 0;

// ============================================
// HELPER FUNCTIONS
// ============================================

// Get user's Mag role
function getUserMagRole(member) {
    if (!member || !member.roles) return null;
    
    for (const roleName of CONFIG.MAG_ROLES) {
        const role = member.roles.cache.find(r => 
            r.name.toLowerCase().includes(roleName.toLowerCase())
        );
        if (role) return roleName;
    }
    return null;
}

// Check if channel is an art channel
function isArtChannel(channelName) {
    return CONFIG.ART_CHANNELS.some(art => 
        channelName.toLowerCase().includes(art.toLowerCase())
    );
}

// Format number with commas
function formatNumber(num) {
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Get today's date string
function getTodayString() {
    return new Date().toISOString().split('T')[0];
}

// ============================================
// DATABASE FUNCTIONS
// ============================================

// Save user message data
async function saveUserMessage(userId, username, displayName, channelId, channelName, isArt = false) {
    const today = getTodayString();
    const userData = {
        username: username,
        displayName: displayName,
        lastActive: Date.now(),
    };
    
    try {
        // Update user info
        await firebaseREST.update(`discord/users/${userId}`, userData);
        
        // Increment total messages
        await firebaseREST.increment(`discord/users/${userId}/totalMessages`);
        
        // Increment channel messages
        await firebaseREST.increment(`discord/users/${userId}/channels/${channelId}`);
        
        // Increment daily messages
        await firebaseREST.increment(`discord/users/${userId}/daily/${today}`);
        
        // Increment global channel stats
        await firebaseREST.increment(`discord/channels/${channelId}/totalMessages`);
        await firebaseREST.update(`discord/channels/${channelId}`, { name: channelName });
        
        // Track art submissions
        if (isArt) {
            await firebaseREST.increment(`discord/users/${userId}/artSubmissions`);
            await firebaseREST.increment(`discord/stats/totalArt`);
        }
        
        // Increment global stats
        await firebaseREST.increment(`discord/stats/totalMessages`);
        await firebaseREST.increment(`discord/stats/daily/${today}`);
        
        console.log(`📝 Tracked message from ${username} in #${channelName}`);
    } catch (error) {
        console.error('Error saving message:', error);
    }
}

// Save user role data
async function saveUserRole(userId, username, roleName) {
    try {
        await firebaseREST.update(`discord/users/${userId}`, {
            username: username,
            magRole: roleName,
            roleUpdated: Date.now()
        });
        
        // Update role distribution stats
        await firebaseREST.increment(`discord/stats/roles/${roleName.replace(' ', '_')}`);
        
        console.log(`🏷️ Updated role for ${username}: ${roleName}`);
    } catch (error) {
        console.error('Error saving role:', error);
    }
}

// Get leaderboard data
async function getLeaderboard(limit = 10) {
    try {
        const users = await firebaseREST.get('discord/users');
        if (!users) return [];
        
        const leaderboard = Object.entries(users)
            .map(([id, data]) => ({
                userId: id,
                username: data.username || 'Unknown',
                displayName: data.displayName || data.username || 'Unknown',
                totalMessages: data.totalMessages || 0,
                artSubmissions: data.artSubmissions || 0,
                magRole: data.magRole || 'None',
            }))
            .sort((a, b) => b.totalMessages - a.totalMessages)
            .slice(0, limit);
        
        return leaderboard;
    } catch (error) {
        console.error('Error getting leaderboard:', error);
        return [];
    }
}

// Get server stats
async function getServerStats() {
    try {
        const stats = await firebaseREST.get('discord/stats');
        return stats || {
            totalMessages: 0,
            totalArt: 0,
            roles: {}
        };
    } catch (error) {
        console.error('Error getting stats:', error);
        return { totalMessages: 0, totalArt: 0, roles: {} };
    }
}

// ============================================
// DISCORD EVENT HANDLERS
// ============================================

// Bot ready
client.once('ready', async () => {
    console.log('');
    console.log('╔════════════════════════════════════════╗');
    console.log('║   🌊 SEISMIC DISCORD ANALYTICS BOT     ║');
    console.log('╠════════════════════════════════════════╣');
    console.log(`║   Logged in as: ${client.user.tag.padEnd(20)}║`);
    console.log(`║   Servers: ${client.guilds.cache.size.toString().padEnd(26)}║`);
    console.log('╚════════════════════════════════════════╝');
    console.log('');
    
    // Register slash commands
    await registerCommands();
    
    // Initial role sync
    console.log('🔄 Syncing member roles...');
    await syncAllMemberRoles();
    
    // Set bot status
    client.user.setActivity('Seismic Analytics', { type: 'WATCHING' });
});

// Message received
client.on('messageCreate', async (message) => {
    // Ignore bots and DMs
    if (message.author.bot) return;
    if (!message.guild) return;
    
    const userId = message.author.id;
    const username = message.author.username;
    const displayName = message.member?.displayName || username;
    const channelId = message.channel.id;
    const channelName = message.channel.name;
    const isArt = isArtChannel(channelName) && message.attachments.size > 0;
    
    // Save message data
    await saveUserMessage(userId, username, displayName, channelId, channelName, isArt);
    
    // Check and save user's Mag role
    const magRole = getUserMagRole(message.member);
    if (magRole) {
        await saveUserRole(userId, username, magRole);
    }
    
    messageCounter++;
});

// Member role update
client.on('guildMemberUpdate', async (oldMember, newMember) => {
    const oldMagRole = getUserMagRole(oldMember);
    const newMagRole = getUserMagRole(newMember);
    
    if (oldMagRole !== newMagRole && newMagRole) {
        await saveUserRole(newMember.id, newMember.user.username, newMagRole);
        console.log(`🎖️ ${newMember.user.username} role changed: ${oldMagRole || 'None'} -> ${newMagRole}`);
    }
});

// New member joined
client.on('guildMemberAdd', async (member) => {
    const magRole = getUserMagRole(member);
    
    await firebaseREST.update(`discord/users/${member.id}`, {
        username: member.user.username,
        displayName: member.displayName,
        joinedAt: member.joinedTimestamp,
        magRole: magRole || 'None',
        totalMessages: 0
    });
    
    await firebaseREST.increment('discord/stats/totalMembers');
    console.log(`👋 New member joined: ${member.user.username}`);
});

// ============================================
// SLASH COMMANDS
// ============================================

const commands = [
    new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Show top message senders')
        .addIntegerOption(option =>
            option.setName('limit')
                .setDescription('Number of users to show (default: 10)')
                .setRequired(false)),
    
    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Show server statistics'),
    
    new SlashCommandBuilder()
        .setName('mystats')
        .setDescription('Show your personal statistics'),
    
    new SlashCommandBuilder()
        .setName('userstats')
        .setDescription('Show statistics for a specific user')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('The user to check')
                .setRequired(true)),
    
    new SlashCommandBuilder()
        .setName('topart')
        .setDescription('Show top art contributors'),
    
    new SlashCommandBuilder()
        .setName('roles')
        .setDescription('Show Mag role distribution'),
];

async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
    
    try {
        console.log('📝 Registering slash commands...');
        
        await rest.put(
            Routes.applicationGuildCommands(CONFIG.CLIENT_ID, CONFIG.GUILD_ID),
            { body: commands.map(cmd => cmd.toJSON()) }
        );
        
        console.log('✅ Slash commands registered!');
    } catch (error) {
        console.error('Error registering commands:', error);
    }
}

// Handle slash commands
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    
    const { commandName } = interaction;
    
    try {
        switch (commandName) {
            case 'leaderboard':
                await handleLeaderboard(interaction);
                break;
            case 'stats':
                await handleStats(interaction);
                break;
            case 'mystats':
                await handleMyStats(interaction);
                break;
            case 'userstats':
                await handleUserStats(interaction);
                break;
            case 'topart':
                await handleTopArt(interaction);
                break;
            case 'roles':
                await handleRoles(interaction);
                break;
        }
    } catch (error) {
        console.error('Command error:', error);
        await interaction.reply({ content: 'An error occurred!', ephemeral: true });
    }
});

// Leaderboard command
async function handleLeaderboard(interaction) {
    await interaction.deferReply();
    
    const limit = interaction.options.getInteger('limit') || 10;
    const leaderboard = await getLeaderboard(limit);
    
    if (leaderboard.length === 0) {
        return interaction.editReply('No data available yet!');
    }
    
    const embed = new EmbedBuilder()
        .setTitle('🏆 Seismic Message Leaderboard')
        .setColor(0xD0A0B7)
        .setDescription(
            leaderboard.map((user, index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**${index + 1}.**`;
                const role = user.magRole !== 'None' ? ` [${user.magRole}]` : '';
                return `${medal} **${user.displayName}**${role}\n   └ ${formatNumber(user.totalMessages)} messages`;
            }).join('\n\n')
        )
        .setFooter({ text: 'Seismic Discord Analytics' })
        .setTimestamp();
    
    await interaction.editReply({ embeds: [embed] });
}

// Stats command
async function handleStats(interaction) {
    await interaction.deferReply();
    
    const stats = await getServerStats();
    const guild = interaction.guild;
    
    const embed = new EmbedBuilder()
        .setTitle('📊 Seismic Server Statistics')
        .setColor(0xD0A0B7)
        .setThumbnail(guild.iconURL())
        .addFields(
            { name: '👥 Total Members', value: formatNumber(guild.memberCount), inline: true },
            { name: '💬 Total Messages', value: formatNumber(stats.totalMessages || 0), inline: true },
            { name: '🎨 Art Submissions', value: formatNumber(stats.totalArt || 0), inline: true },
        )
        .setFooter({ text: 'Seismic Discord Analytics' })
        .setTimestamp();
    
    await interaction.editReply({ embeds: [embed] });
}

// My stats command
async function handleMyStats(interaction) {
    await interaction.deferReply();
    
    const userId = interaction.user.id;
    const userData = await firebaseREST.get(`discord/users/${userId}`);
    
    if (!userData) {
        return interaction.editReply('No data found for you yet! Start chatting to build your stats.');
    }
    
    const embed = new EmbedBuilder()
        .setTitle(`📈 Stats for ${interaction.user.displayName}`)
        .setColor(0xD0A0B7)
        .setThumbnail(interaction.user.displayAvatarURL())
        .addFields(
            { name: '💬 Total Messages', value: formatNumber(userData.totalMessages || 0), inline: true },
            { name: '🎨 Art Submissions', value: formatNumber(userData.artSubmissions || 0), inline: true },
            { name: '🏷️ Mag Role', value: userData.magRole || 'None', inline: true },
        )
        .setFooter({ text: 'Seismic Discord Analytics' })
        .setTimestamp();
    
    await interaction.editReply({ embeds: [embed] });
}

// User stats command
async function handleUserStats(interaction) {
    await interaction.deferReply();
    
    const targetUser = interaction.options.getUser('user');
    const userData = await firebaseREST.get(`discord/users/${targetUser.id}`);
    
    if (!userData) {
        return interaction.editReply(`No data found for ${targetUser.username}!`);
    }
    
    const embed = new EmbedBuilder()
        .setTitle(`📈 Stats for ${targetUser.displayName}`)
        .setColor(0xD0A0B7)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
            { name: '💬 Total Messages', value: formatNumber(userData.totalMessages || 0), inline: true },
            { name: '🎨 Art Submissions', value: formatNumber(userData.artSubmissions || 0), inline: true },
            { name: '🏷️ Mag Role', value: userData.magRole || 'None', inline: true },
        )
        .setFooter({ text: 'Seismic Discord Analytics' })
        .setTimestamp();
    
    await interaction.editReply({ embeds: [embed] });
}

// Top art command
async function handleTopArt(interaction) {
    await interaction.deferReply();
    
    const users = await firebaseREST.get('discord/users');
    if (!users) {
        return interaction.editReply('No art data available yet!');
    }
    
    const artLeaderboard = Object.entries(users)
        .map(([id, data]) => ({
            userId: id,
            displayName: data.displayName || data.username || 'Unknown',
            artSubmissions: data.artSubmissions || 0,
            magRole: data.magRole || 'None',
        }))
        .filter(u => u.artSubmissions > 0)
        .sort((a, b) => b.artSubmissions - a.artSubmissions)
        .slice(0, 10);
    
    if (artLeaderboard.length === 0) {
        return interaction.editReply('No art submissions tracked yet!');
    }
    
    const embed = new EmbedBuilder()
        .setTitle('🎨 Top Art Contributors')
        .setColor(0xD0A0B7)
        .setDescription(
            artLeaderboard.map((user, index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**${index + 1}.**`;
                return `${medal} **${user.displayName}** - ${formatNumber(user.artSubmissions)} artworks`;
            }).join('\n')
        )
        .setFooter({ text: 'Seismic Discord Analytics' })
        .setTimestamp();
    
    await interaction.editReply({ embeds: [embed] });
}

// Roles command
async function handleRoles(interaction) {
    await interaction.deferReply();
    
    const stats = await getServerStats();
    const roles = stats.roles || {};
    
    const embed = new EmbedBuilder()
        .setTitle('🏷️ Mag Role Distribution')
        .setColor(0xD0A0B7)
        .setDescription(
            CONFIG.MAG_ROLES.map(role => {
                const count = roles[role.replace(' ', '_')] || 0;
                const bar = '█'.repeat(Math.min(count, 20)) + '░'.repeat(Math.max(0, 20 - count));
                return `**${role}**: ${bar} ${count}`;
            }).join('\n\n')
        )
        .setFooter({ text: 'Seismic Discord Analytics' })
        .setTimestamp();
    
    await interaction.editReply({ embeds: [embed] });
}

// Sync all member roles on startup
async function syncAllMemberRoles() {
    try {
        const guild = client.guilds.cache.get(CONFIG.GUILD_ID);
        if (!guild) {
            console.log('⚠️ Guild not found. Make sure GUILD_ID is correct.');
            return;
        }
        
        const members = await guild.members.fetch();
        let synced = 0;
        
        for (const [id, member] of members) {
            if (member.user.bot) continue;
            
            const magRole = getUserMagRole(member);
            if (magRole) {
                await firebaseREST.update(`discord/users/${id}`, {
                    username: member.user.username,
                    displayName: member.displayName,
                    magRole: magRole
                });
                synced++;
            }
        }
        
        console.log(`✅ Synced ${synced} member roles`);
    } catch (error) {
        console.error('Error syncing roles:', error);
    }
}

// ============================================
// ERROR HANDLING
// ============================================
client.on('error', console.error);
process.on('unhandledRejection', console.error);

// ============================================
// START BOT
// ============================================
console.log('🚀 Starting Seismic Discord Analytics Bot...');
client.login(CONFIG.DISCORD_TOKEN);
